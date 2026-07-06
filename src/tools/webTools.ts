import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as cheerio from "cheerio";

export function registerWebTools(server: McpServer) {
  server.registerTool(
    "scrape_url",
    {
      description:
        "Fetch a URL and return the visible text content of the page. Strips HTML tags, scripts, and styles. Returns clean, readable text.",
      inputSchema: {
        url: z.string().url().describe("The URL to scrape (e.g. https://example.com)"),
        max_length: z
          .number()
          .min(100)
          .max(500_000)
          .optional()
          .default(100_000)
          .describe("Maximum characters to return. Default 100000, max 500000."),
      },
    },
    async ({ url, max_length }) => {
      try {
        const response = await fetch(url, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8",
          },
          signal: AbortSignal.timeout(15_000),
        });

        if (!response.ok) {
          return {
            content: [{ type: "text" as const, text: `Failed to fetch ${url}: HTTP ${response.status} ${response.statusText}` }],
          };
        }

        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("text/html") && !contentType.includes("html")) {
          const text = await response.text();
          return {
            content: [
              {
                type: "text" as const,
                text:
                  text.length > max_length
                    ? text.slice(0, max_length) + "\n\n... [truncated]"
                    : text,
              },
            ],
          };
        }

        const html = await response.text();
        const $ = cheerio.load(html);
        $("script, style, noscript, iframe, nav, footer, head").remove();
        let text = $("body").text();
        text = text.replace(/\s+/g, " ").replace(/\n\s*\n/g, "\n\n").trim();

        if (text.length === 0) {
          return {
            content: [{ type: "text" as const, text: `Page fetched successfully but no visible text content found: ${url}` }],
          };
        }

        const title = $("title").text().trim();
        const header = title ? `Page: ${title}\nURL: ${url}\n\n` : `URL: ${url}\n\n`;
        const fullText = header + text;
        const result =
          fullText.length > max_length
            ? fullText.slice(0, max_length) + "\n\n... [truncated]"
            : fullText;

        return {
          content: [{ type: "text" as const, text: result }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Error scraping URL ${url}: ${message}` }],
          isError: true,
        };
      }
    }
  );

  // Register websearch tool
  const SEARXNG_BASE_URL = process.env.SEARXNG_URL ?? "http://localhost:5001";

  server.registerTool(
    "websearch",
    {
      description:
        "Search the web using a self-hosted SearXNG instance. Returns a list of results with titles, URLs, and snippets.",
      inputSchema: {
        query: z
          .string()
          .describe("The search query string."),
        limit: z
          .number()
          .min(1)
          .max(20)
          .optional()
          .default(5)
          .describe("Maximum number of results to return. Default 5, max 20."),
      },
    },
    async ({ query, limit }) => {
      try {
        const searchUrl =
          `${SEARXNG_BASE_URL.replace(/\/+$/, "")}/search` +
          `?q=${encodeURIComponent(query)}&format=json`;

        const response = await fetch(searchUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            Accept: "application/json",
            "Accept-Language": "en-US,en;q=0.9",
          },
          signal: AbortSignal.timeout(10_000),
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = (await response.json()) as {
          results?: Array<{ title?: string; url?: string; content?: string }>;
        };

        // Canonicaliza a URL para remover duplicatas (ignora query e barra final).
        const seen = new Set<string>();
        const dedupeKey = (url: string) =>
          url.split("?")[0].replace(/\/+$/, "").toLowerCase();

        const results = (data.results ?? [])
          .map((r) => ({
            title: r.title ?? "",
            url: r.url ?? "",
            snippet: (r.content ?? "").trim(),
          }))
          .filter((r) => r.title && r.url)
          .filter((r) => {
            const key = dedupeKey(r.url);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .slice(0, limit);

        if (results.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No results found." }],
          };
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Error searching for '${query}': ${message}` }],
          isError: true,
        };
      }
    }
  );
}
