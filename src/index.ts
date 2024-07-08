import { getAccessToken } from "./shared/auth";
import {
  convertToSiteUrl,
  getPublishMetadata,
  requestIndexing,
  getEmojiForStatus,
  getPageIndexingStatus,
  convertToFilePath,
  checkSiteUrl,
  checkCustomUrls,
} from "./shared/gsc";
import { getSitemapUrls } from "./shared/sitemap";
import { IndexingStatus, Page, PageStatus } from "./shared/types";
import { batch, parseCommandLineArgs } from "./shared/utils";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import path from "path";

const CACHE_TIMEOUT = 1000 * 60 * 60 * 24 * 14; // 14 days
export const QUOTA = {
  rpm: {
    retries: 3,
    waitingTime: 60000, // 1 minute
  },
};

export type IndexOptions = {
  client_email?: string;
  private_key?: string;
  path?: string;
  urls?: string[];
  quota?: {
    rpmRetry?: boolean; // read requests per minute: retry after waiting time
  };
};

/**
 * Indexes the specified domain or site URL.
 * @param input - The domain or site URL to index.
 * @param options - (Optional) Additional options for indexing.
 */
export const index = async (input: string = process.argv[2], options: IndexOptions = {}) => {
  if (!input) {
    console.error("❌ Please provide a domain or site URL as the first argument.");
    console.error("");
    process.exit(1);
  }

  const args = parseCommandLineArgs(process.argv.slice(2));
  if (!options.client_email) {
    options.client_email = args["client-email"] || process.env.GIS_CLIENT_EMAIL;
  }
  if (!options.private_key) {
    options.private_key = args["private-key"] || process.env.GIS_PRIVATE_KEY;
  }
  if (!options.path) {
    options.path = args["path"] || process.env.GIS_PATH;
  }
  if (!options.urls) {
    options.urls = args["urls"] ? args["urls"].split(",") : undefined;
  }
  if (!options.quota) {
    options.quota = {
      rpmRetry: args["rpm-retry"] === "true" || process.env.GIS_QUOTA_RPM_RETRY === "true",
    };
  }

  const accessToken = await getAccessToken(options.client_email, options.private_key, options.path);
  let siteUrl = convertToSiteUrl(input);
  console.log(`🔎 Processing site: ${siteUrl}`);
  const cachePath = path.join(".cache", `${convertToFilePath(siteUrl)}.json`);

  if (!accessToken) {
    console.error("❌ Failed to get access token, check your service account credentials.");
    console.error("");
    process.exit(1);
  }

  siteUrl = await checkSiteUrl(accessToken, siteUrl);

  let urls = options.urls || [];
  if (urls.length === 0) {
    console.log(`🔎 Fetching sitemaps and pages...`);
    const [sitemaps, urlsFromSitemaps] = await getSitemapUrls(accessToken, siteUrl);

    if (sitemaps.length === 0) {
      console.error("❌ No sitemaps found, add them to Google Search Console and try again.");
      console.error("");
      process.exit(1);
    }

    urls = urlsFromSitemaps;

    console.log(`👉 Found ${urls.length} URLs in ${sitemaps.length} sitemap`);
  } else {
    urls = checkCustomUrls(siteUrl, urls);
    console.log(`👉 Found ${urls.length} URLs in the provided list`);
  }

  const pages: Record<string, Page> = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
  const pagesPerIndexingStatus: Record<IndexingStatus, string[]> = {
    [IndexingStatus.SubmittedAndIndexed]: [],
    [IndexingStatus.DuplicateWithoutUserSelectedCanonical]: [],
    [IndexingStatus.CrawledCurrentlyNotIndexed]: [],
    [IndexingStatus.DiscoveredCurrentlyNotIndexed]: [],
    [IndexingStatus.PageWithRedirect]: [],
    [IndexingStatus.URLIsUnknownToGoogle]: [],
    [IndexingStatus.RateLimited]: [],
    [IndexingStatus.Forbidden]: [],
    [IndexingStatus.Error]: [],
  };

  const indexableStatuses = [
    IndexingStatus.DiscoveredCurrentlyNotIndexed,
    IndexingStatus.CrawledCurrentlyNotIndexed,
    IndexingStatus.URLIsUnknownToGoogle,
    IndexingStatus.Forbidden,
    IndexingStatus.Error,
  ];

  const shouldRecheck = (page: Page) => {
    const isFailed = page.status === PageStatus.Failed;
    const isOld = new Date(page.lastCheckedAt) < new Date(Date.now() - CACHE_TIMEOUT);
    return isOld || isFailed;
  };

  await batch(
    async (url) => {
      let page = pages[url];
      if (!page || shouldRecheck(page)) {
        const indexingStatus = await getPageIndexingStatus(accessToken, siteUrl, url);
        page = {
          indexingStatus,
          status: indexableStatuses.includes(indexingStatus)
            ? PageStatus.Pending
            : indexingStatus === IndexingStatus.RateLimited
            ? PageStatus.Failed
            : PageStatus.Completed,
          lastCheckedAt: new Date().toISOString(),
        };
        pages[url] = page;
      }

      pagesPerIndexingStatus[page.indexingStatus] = pagesPerIndexingStatus[page.indexingStatus]
        ? [...pagesPerIndexingStatus[page.indexingStatus], url]
        : [url];
    },
    urls,
    50,
    (batchIndex, batchCount) => {
      console.log(`📦 Batch ${batchIndex + 1} of ${batchCount} complete`);
    }
  );

  console.log(``);
  console.log(`👍 Done, here's the indexing status of all ${Object.keys(pages).length} pages:`);
  mkdirSync(".cache", { recursive: true });
  writeFileSync(cachePath, JSON.stringify(pages, null, 2));

  for (const indexingStatus of Object.keys(pagesPerIndexingStatus)) {
    const pages = pagesPerIndexingStatus[indexingStatus as IndexingStatus];
    if (pages.length === 0) continue;
    console.log(`   • ${getEmojiForStatus(indexingStatus as IndexingStatus)} ${indexingStatus}: ${pages.length} pages`);
  }
  console.log("");

  const shouldBeSubmitted = (page: Page) => {
    return page.status === PageStatus.Pending;
  };

  const queue = Object.keys(pages).filter((url) => shouldBeSubmitted(pages[url]));

  if (queue.length === 0) {
    console.log(`✨ There are no pages that can be indexed for now.`);
  } else {
    console.log(`✨ Found ${queue.length} pages that can be indexed.`);
    queue.forEach((url) => console.log(`   • ${url}`));
  }
  console.log(``);

  for (const url of queue) {
    console.log(`📄 Processing url: ${url}`);
    const status = await getPublishMetadata(accessToken, url, {
      retriesOnRateLimit: options.quota.rpmRetry ? QUOTA.rpm.retries : 0,
    });
    if (status === 404) {
      await requestIndexing(accessToken, url);
      console.log("🚀 Indexing requested successfully. It may take a few days for Google to process it.");
    } else if (status < 400) {
      console.log(`🕛 Indexing already requested previously. It may take a few days for Google to process it.`);
    }
    console.log(``);
  }

  console.log(`👍 All done!`);
  console.log(`💖 Brought to you by https://seogets.com - SEO Analytics.`);
  console.log(``);
};

export * from "./shared";
