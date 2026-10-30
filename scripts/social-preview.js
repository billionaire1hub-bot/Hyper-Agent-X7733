#!/usr/bin/env node
/**
 * Generates one article from live data and prints the thread without posting.
 *
 *   node scripts/social-preview.js
 *   node scripts/social-preview.js technical_setup
 */
import { ARTICLE_THEMES, generateArticle, pickArticleTheme } from "../src/services/articles.js";

const requested = process.argv[2];
const theme = ARTICLE_THEMES.includes(requested) ? requested : pickArticleTheme();
const article = await generateArticle({ theme, maxLength: 6 });

console.log(`theme: ${theme}`);
console.log(`engine: ${article.engine}`);
console.log(`title: ${article.title}`);
console.log(`sentiment: ${article.sentiment ?? "n/a"} (confidence ${article.confidence ?? "n/a"})`);
console.log(`sources: ${article.sources.map((source) => source.provider).join(", ")}`);
console.log("");
article.tweets.forEach((tweet, index) => {
  console.log(`--- tweet ${index + 1}/${article.tweets.length} (${tweet.length} chars) ---`);
  console.log(tweet);
  console.log("");
});
