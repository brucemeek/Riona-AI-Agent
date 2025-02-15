import { Browser, DEFAULT_INTERCEPT_RESOLUTION_PRIORITY } from "puppeteer";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import AdblockerPlugin from "puppeteer-extra-plugin-adblocker";
import UserAgent from "user-agents";
import { Server } from "proxy-chain";
import { IGpassword, IGusername } from "../secret";
import { generateFluxImage } from "../utils/imageGenerator";
import logger from "../config/logger";
import { Instagram_cookiesExist, loadCookies, saveCookies } from "../utils";
import { runAgent } from "../Agent";
import { getInstagramCommentSchema } from "../Agent/schema";
let lastCreatedPostTime: Date | null = null;

// Add stealth plugin to puppeteer
puppeteer.use(StealthPlugin());
puppeteer.use(
    AdblockerPlugin({
        // Optionally enable Cooperative Mode for several request interceptors
        interceptResolutionPriority: DEFAULT_INTERCEPT_RESOLUTION_PRIORITY,
    })
);

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function runInstagram() {
    const server = new Server({ port: 8000 });
    await server.listen();
    const proxyUrl = `http://localhost:8000`;
    const browser = await puppeteer.launch({
        headless: false,
        args: [`--proxy-server=${proxyUrl}`],
    });

    const page = await browser.newPage();
    const cookiesPath = "./cookies/Instagramcookies.json";

    const checkCookies = await Instagram_cookiesExist();
    logger.info(`Checking cookies existence: ${checkCookies}`);

    if (checkCookies) {
        const cookies = await loadCookies(cookiesPath);
        await page.setCookie(...cookies);
        logger.info('Cookies loaded and set on the page.');

        // Navigate to Instagram to verify if cookies are valid
        await page.goto("https://www.instagram.com/", { waitUntil: 'networkidle2' });

        // Check if login was successful by verifying page content (e.g., user profile or feed)
        const isLoggedIn = await page.$("a[href='/direct/inbox/']");
        if (isLoggedIn) {
            logger.info("Login verified with cookies.");
        } else {
            logger.warn("Cookies invalid or expired. Logging in again...");
            await loginWithCredentials(page, browser);
        }
    } else {
        // If no cookies are available, perform login with credentials
        await loginWithCredentials(page, browser);
    }

    // Optionally take a screenshot after loading the page
    await page.screenshot({ path: "logged_in.png" });

    // Navigate to the Instagram homepage
    await page.goto("https://www.instagram.com/");

    // Continuously manage posts based on timing and comments
    while (true) {
         await handlePostLogic(page);
         logger.info("Cycle complete, waiting 30 minutes for next check...");
         await delay(1800000);
         await page.goto("https://www.instagram.com/");
    }
}

const loginWithCredentials = async (page: any, browser: Browser) => {
    try {
        await page.goto("https://www.instagram.com/accounts/login/");
        await page.waitForSelector('input[name="username"]');

        // Fill out the login form
        await page.type('input[name="username"]', IGusername); // Replace with your username
        await page.type('input[name="password"]', IGpassword); // Replace with your password
        await page.click('button[type="submit"]');

        // Wait for navigation after login
        await page.waitForNavigation();

        // Save cookies after login
        const cookies = await browser.cookies();
        // logger.info("Saving cookies after login...",cookies);
        await saveCookies("./cookies/Instagramcookies.json", cookies);
    } catch (error) {
        // logger.error("Error logging in with credentials:", error);
        logger.error("Error logging in with credentials:");
    }
}

async function interactWithPosts(page: any) {
    let postIndex = 1; // Start with the first post
    const maxPosts = 50; // Limit to prevent infinite scrolling

    while (postIndex <= maxPosts) {
        try {
            const postSelector = `article:nth-of-type(${postIndex})`;

            // Check if the post exists
            if (!(await page.$(postSelector))) {
                console.log("No more posts found. Ending iteration...");
                return;
            }

            const likeButtonSelector = `${postSelector} svg[aria-label="Like"]`;
            const likeButton = await page.$(likeButtonSelector);
            const ariaLabel = await likeButton?.evaluate((el: Element) =>
                el.getAttribute("aria-label")
            );

            if (ariaLabel === "Like") {
                console.log(`Liking post ${postIndex}...`);
                await likeButton.click();
                await page.keyboard.press("Enter");
                console.log(`Post ${postIndex} liked.`);
            } else if (ariaLabel === "Unlike") {
                console.log(`Post ${postIndex} is already liked.`);
            } else {
                console.log(`Like button not found for post ${postIndex}.`);
            }

            // Extract and log the post caption
            const captionSelector = `${postSelector} div.x9f619 span._ap3a div span._ap3a`;
            const captionElement = await page.$(captionSelector);

            let caption = "";
            if (captionElement) {
                caption = await captionElement.evaluate((el: HTMLElement) => el.innerText);
                console.log(`Caption for post ${postIndex}: ${caption}`);
            } else {
                console.log(`No caption found for post ${postIndex}.`);
            }

            // Check if there is a '...more' link to expand the caption
            const moreLinkSelector = `${postSelector} div.x9f619 span._ap3a span div span.x1lliihq`;
            const moreLink = await page.$(moreLinkSelector);
            if (moreLink) {
                console.log(`Expanding caption for post ${postIndex}...`);
                await moreLink.click();
                const expandedCaption = await captionElement.evaluate(
                    (el: HTMLElement) => el.innerText
                );
                console.log(`Expanded Caption for post ${postIndex}: ${expandedCaption}`);
                caption = expandedCaption;
            }

            // Comment on the post
            const commentBoxSelector = `${postSelector} textarea`;
            const commentBox = await page.$(commentBoxSelector);
            if (commentBox) {
                console.log(`Commenting on post ${postIndex}...`);
                const prompt = `Craft a thoughtful, engaging, and mature reply to the following post: "${caption}". Ensure the reply is relevant, insightful, and adds value to the conversation. It should reflect empathy and professionalism, and avoid sounding too casual or superficial. also it should be 300 characters or less. and it should not go against instagram Community Standards on spam. so you will have to try your best to humanize the reply`;
                const schema = getInstagramCommentSchema();
                const result = await runAgent(schema, prompt);
                const comment = result[0]?.comment;
                await commentBox.type(comment);

                // New selector approach for the post button
                const postButton = await page.evaluateHandle(() => {
                    const buttons = Array.from(document.querySelectorAll('div[role="button"]'));
                    return buttons.find(button => button.textContent === 'Post' && !button.hasAttribute('disabled'));
                });

                if (postButton) {
                    console.log(`Posting comment on post ${postIndex}...`);
                    await postButton.click();
                    console.log(`Comment posted on post ${postIndex}.`);
                } else {
                    console.log("Post button not found.");
                }
            } else {
                console.log("Comment box not found.");
            }

            // Wait before moving to the next post
            const waitTime = Math.floor(Math.random() * 5000) + 5000;
            console.log(`Waiting ${waitTime / 1000} seconds before moving to the next post...`);
            await delay(waitTime);

            // Scroll to the next post
            await page.evaluate(() => {
                window.scrollBy(0, window.innerHeight);
            });

            postIndex++;
        } catch (error) {
            console.error(`Error interacting with post ${postIndex}:`, error);
            break;
        }
    }
}

async function handlePostLogic(page: any) {
    try {
        const currentTime = new Date();
        if (lastCreatedPostTime !== null) {
            const diffHoursFromGlobal = (currentTime.getTime() - lastCreatedPostTime.getTime()) / (1000 * 60 * 60);
            if (diffHoursFromGlobal < 6) {
                console.log("A post was created less than 6 hours ago, replying to comments.");
                await replyToComments(page);
                const closeButtonSelector = 'svg[aria-label="Close"]';
                const closeButton = await page.$(closeButtonSelector);
                if (closeButton) {
                    await closeButton.click();
                }
                return;
            }
        }
        await page.goto(`https://www.instagram.com/${IGusername}/`, { waitUntil: "networkidle2" });
        // Check if any posts exist on the profile
        const postsArr = await page.$$("article a");
        if (postsArr.length === 0) {
            console.log("No posts found on profile. Creating the first post.");
            await createNewPost(page, true);
            return;
        }
        const firstPostSelector = "article a";
        let postLink = null;
        try {
            await page.waitForSelector(firstPostSelector, { timeout: 20000 });
            postLink = await page.$(firstPostSelector);
        } catch (error) {
            console.log("Timeout waiting for post selector; no posts found.");
        }
        if (!postLink) {
            console.log("No posts found on profile. Creating a new post.");
            await createNewPost(page);
            return;
        }
        await postLink.click();
        await page.waitForSelector("time", { timeout: 10000 });
        const datetime = await page.$eval("time", (el: Element) => el.getAttribute("datetime"));
        if (!datetime) {
            console.log("No timestamp found. Creating a new post.");
            await createNewPost(page);
            return;
        }
        const lastPostTime = new Date(datetime);
        const diffHours = (currentTime.getTime() - lastPostTime.getTime()) / (1000 * 60 * 60);
        if (diffHours >= 6) {
            console.log("It's been more than 6 hours since the last post. Creating a new post.");
            await createNewPost(page);
        } else {
            console.log("Less than 6 hours since the last post. Replying to comments.");
            await replyToComments(page);
        }
        const closeButtonSelector = 'svg[aria-label="Close"]';
        const closeButton = await page.$(closeButtonSelector);
        if (closeButton) {
            await closeButton.click();
        }
    } catch (err) {
        console.error("Error in handlePostLogic:", err);
    }
}

async function createNewPost(page: any, isFreshAccount: boolean = false) {
    try {
        // Polyfill for waitForXPath if not available
        if (typeof page.waitForXPath !== 'function') {
            page.waitForXPath = async (xpath: string, options: any = {}) => {
                await page.waitForFunction(
                    (xp: string) => {
                        const result = document.evaluate(
                            xp,
                            document,
                            null,
                            XPathResult.FIRST_ORDERED_NODE_TYPE,
                            null
                        );
                        return result.singleNodeValue !== null;
                    },
                    options,
                    xpath
                );
                return page.$x(xpath);
            };
        }
        // Polyfill for $x if not available
        if (typeof page.$x !== 'function') {
            page.$x = async (xpath: string): Promise<any[]> => {
                const resultHandle = await page.evaluateHandle((xp: string) => {
                    const nodes = [];
                    const snapshot = document.evaluate(
                        xp,
                        document,
                        null,
                        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
                        null
                    );
                    for (let i = 0; i < snapshot.snapshotLength; i++) {
                        nodes.push(snapshot.snapshotItem(i));
                    }
                    return nodes;
                }, xpath);
                const properties = await resultHandle.getProperties();
                const elements: any[] = [];
                for (const property of properties.values()) {
                    const element = property.asElement();
                    if (element) {
                        elements.push(element);
                    }
                }
                return elements;
            };
        }
        let newPostXpath;
        if (isFreshAccount) {
            // For fresh accounts, use the "Share your first photo" button
            newPostXpath = "//div[contains(text(),'Share your first photo')]";
            console.log("Fresh account detected. Using 'Share your first photo' button.");
        } else {
            // For accounts with posts, use the "Post" button to create a new post
            newPostXpath = "//div[.//span[text()='Post']]";
            console.log("Existing account detected. Using 'Post' button.");
        }
        await page.waitForXPath(newPostXpath, { timeout: 20000 });
        const [newPostButton] = await page.$x(newPostXpath);
        if (!newPostButton) {
            console.log("New post button not found. Aborting post creation.");
            return;
        }
        console.log("Clicking new post button...");
        await newPostButton.click();
        // Wait for the file input element that signals the start of the post creation flow
await page.waitForSelector("input[type='file']", { timeout: 20000 });

// Generate caption first using AI agent
const captionPrompt = "Generate a cool caption for the new Instagram post. Keep it under 2200 characters.";
const schema = getInstagramCommentSchema();
const captionResult = await runAgent(schema, captionPrompt);
const caption = captionResult[0]?.comment || "New Post";
console.log(`Generated caption: ${caption}`);

// Create image prompt based on the generated caption
const imagePrompt = `Generate an Instagram post image that visually represents the following concept: "${caption}". Ensure the image is vivid and eye-catching with a 1:1 aspect ratio.`;

// Generate the image using FLUX.1 integration
const imagePath = await generateFluxImage(page, imagePrompt);
const fileInput = await page.$("input[type='file']");
await fileInput.uploadFile(imagePath);

console.log("New post creation flow initiated. (Simulated post creation)");
console.log(`New post caption: ${caption}`);
console.log("Post created successfully.");
lastCreatedPostTime = new Date();
    } catch (err) {
        console.error("Error in createNewPost:", err);
        lastCreatedPostTime = new Date();
    }
}

async function replyToComments(page: any) {
    try {
        const commentSelector = "ul li div.C4VMK > span";
        await page.waitForSelector(commentSelector, { timeout: 5000 });
        const commentElements = await page.$$(commentSelector);
        if (!commentElements || commentElements.length === 0) {
            console.log("No comments available to reply to.");
            return;
        }
        const limit = Math.min(3, commentElements.length);
        for (let i = 0; i < limit; i++) {
            const commentText = await commentElements[i].evaluate((el: Element) => el.textContent);
            console.log(`Found comment: ${commentText}`);
            const prompt = `Craft a thoughtful reply to: "${commentText}". Keep it under 300 characters.`;
            const schema = getInstagramCommentSchema();
            const result = await runAgent(schema, prompt);
            const replyText = result[0]?.comment;
            console.log(`Generated reply: ${replyText}`);
            console.log(`Replying with: ${replyText}`);
        }
    } catch (err) {
        console.error("Error in replying to comments:", err);
    }
}

export { runInstagram };
