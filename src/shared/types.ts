/**
 * Enum representing indexing status of a URL
 */
export enum IndexingStatus {
  SubmittedAndIndexed = "Submitted and indexed",
  DuplicateWithoutUserSelectedCanonical = "Duplicate without user-selected canonical",
  CrawledCurrentlyNotIndexed = "Crawled - currently not indexed",
  DiscoveredCurrentlyNotIndexed = "Discovered - currently not indexed",
  PageWithRedirect = "Page with redirect",
  URLIsUnknownToGoogle = "URL is unknown to Google",
  RateLimited = "RateLimited",
  Forbidden = "Forbidden",
  Error = "Error",
}

/**
 * Enum representing status of a task
 */
export enum PageStatus {
  Pending = "Pending",
  Processing = "Processing",
  Completed = "Completed",
  Failed = "Failed",
}

export type Page = {
  status: PageStatus;
  indexingStatus: IndexingStatus;
  lastCheckedAt: string;
};
