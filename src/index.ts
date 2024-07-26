import { cancel, intro, isCancel, log, spinner } from "@clack/prompts";
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
import { getSitemapPages } from "./shared/sitemap";
import { Status } from "./shared/types";
import { batch, parseCommandLineArgs } from "./shared/utils";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import path from "path";
import { cyan, green, blue, yellow } from "picocolors";

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
  intro(`Welcome to ${cyan("Google Indexing API")}! 🚀`);

  if (!input) {
    log.message("")
    cancel("Please provide a domain or site URL as the first argument.");
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

  const s = spinner();
  if (isCancel(s)) {
    cancel("Operation cancelled.");
    process.exit(1);
  }

  const accessToken = await getAccessToken(options.client_email, options.private_key, options.path);
  let siteUrl = convertToSiteUrl(input);
  s.start(`Processing site: ${siteUrl} - Getting access token`);
  const cachePath = path.join(".cache", `${convertToFilePath(siteUrl)}.json`);

  if (!accessToken) {
    log.message("")
    cancel("Failed to get access token, check your service account credentials.");
    process.exit(1);
  }

  s.message(`Processing site: ${siteUrl} - Checking access to the site on Google Search Console`);
  siteUrl = await checkSiteUrl(accessToken, siteUrl);

  s.stop(`Processing site: ${siteUrl} - ${green("Access granted!")}`);

  let pages = options.urls || [];
  if (pages.length === 0) {
    s.start(`Fetching sitemaps and pages`);
    const [sitemaps, pagesFromSitemaps] = await getSitemapPages(accessToken, siteUrl);

    if (sitemaps.length === 0) {
      log.message("")
      cancel("No sitemaps found, add them to Google Search Console and try again.");
      process.exit(1);
    }

    pages = pagesFromSitemaps;

    s.stop(`Found ${pages.length} URLs in ${sitemaps.length} sitemap`);
  } else {
    pages = checkCustomUrls(siteUrl, pages);
    s.stop(`Found ${pages.length} URLs in the provided list`);
  }

  const statusPerUrl: Record<string, { status: Status; lastCheckedAt: string }> = existsSync(cachePath)
    ? JSON.parse(readFileSync(cachePath, "utf8"))
    : {};
  const pagesPerStatus: Record<Status, string[]> = {
    [Status.SubmittedAndIndexed]: [],
    [Status.DuplicateWithoutUserSelectedCanonical]: [],
    [Status.CrawledCurrentlyNotIndexed]: [],
    [Status.DiscoveredCurrentlyNotIndexed]: [],
    [Status.PageWithRedirect]: [],
    [Status.URLIsUnknownToGoogle]: [],
    [Status.RateLimited]: [],
    [Status.Forbidden]: [],
    [Status.Error]: [],
  };

  const indexableStatuses = [
    Status.DiscoveredCurrentlyNotIndexed,
    Status.CrawledCurrentlyNotIndexed,
    Status.URLIsUnknownToGoogle,
    Status.Forbidden,
    Status.Error,
    Status.RateLimited,
  ];

  const shouldRecheck = (status: Status, lastCheckedAt: string) => {
    const shouldIndexIt = indexableStatuses.includes(status);
    const isOld = new Date(lastCheckedAt) < new Date(Date.now() - CACHE_TIMEOUT);
    return shouldIndexIt && isOld;
  };

  s.start(`Checking indexing status of ${pages.length} pages`);

  const batchSize = 50;
  await batch(
    async (url, itemIndex, batchIndex, batchCount) => {
      let result = statusPerUrl[url];
      if (!result || shouldRecheck(result.status, result.lastCheckedAt)) {
        const status = await getPageIndexingStatus(accessToken, siteUrl, url);
        result = { status, lastCheckedAt: new Date().toISOString() };
        statusPerUrl[url] = result;
      }

      pagesPerStatus[result.status] = pagesPerStatus[result.status] ? [...pagesPerStatus[result.status], url] : [url];

      s.message(`Batch ${batchIndex + 1} of ${batchCount} - ${blue(`${itemIndex + 1}/${batchSize}`)}`);
    },
    pages,
    batchSize,
    (batchIndex, batchCount) => {
      s.message(`Batch ${batchIndex + 1} of ${batchCount} - ${green("Completed")}`);
    }
  );

  s.stop(`Done, here's the status of all ${pages.length} pages:`)

  mkdirSync(".cache", { recursive: true });
  writeFileSync(cachePath, JSON.stringify(statusPerUrl, null, 2));

  for (const status of Object.keys(pagesPerStatus)) {
    const pages = pagesPerStatus[status as Status];
    if (pages.length === 0) continue;
    log.message(`   • ${getEmojiForStatus(status as Status)} ${status}: ${pages.length} pages`);
  }
  log.message("");

  const indexablePages = Object.entries(pagesPerStatus).flatMap(([status, pages]) =>
    indexableStatuses.includes(status as Status) ? pages : []
  );

  if (indexablePages.length === 0) {
    log.warn(`There are no pages that can be indexed. Everything is already indexed!`);
  } else {
    log.success(`✨ Found ${indexablePages.length} pages that can be indexed.`);
  }
  log.message(``);

  for (const url of indexablePages) {
    s.start(`${url} - ${yellow("Requesting indexing...")}`);
    const status = await getPublishMetadata(accessToken, url, {
      retriesOnRateLimit: options.quota.rpmRetry ? QUOTA.rpm.retries : 0,
    });
    if (status === 404) {
      await requestIndexing(accessToken, url);
      s.stop(`${url} - ${green("Indexed successfully!")}`);
    } else if (status < 400) {
      s.stop(`${url} - ${blue("Already indexed!")}`);
    }
    log.message("");
  }

  log.message(`All done! 👍`);
  log.message(`Brought to you by https://seogets.com - SEO Analytics. 💖`);
  log.message(``);
};

export * from "./shared";
