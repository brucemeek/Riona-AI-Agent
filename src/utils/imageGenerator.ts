import { Page } from "puppeteer";
import { download } from "./download";

export async function generateFluxImage(page: Page, prompt: string): Promise<string> {
    const fluxPage = await page.browser().newPage();
    await fluxPage.goto('https://redpandaai.com/tools/flux.1-dev');
    
    // Generate random seed between 0 and 2147483647
    const seed = Math.floor(Math.random() * 2147483647);

    // Fill out the form
    await fluxPage.type('#prompt-input', prompt);
    await fluxPage.click('button[aria-label="1:1 aspect ratio"]');
    await fluxPage.type('#seed-input', seed.toString());
    await fluxPage.type('#guidance-input', '4');
    await fluxPage.type('#steps-input', '28');

    // Handle CAPTCHA - NOTE: This will need manual intervention
    console.log("Pausing for CAPTCHA solution...");
    await new Promise(resolve => setTimeout(resolve, 30000)); // 30 seconds pause

    // Click generate button
    await fluxPage.click('button:has-text("Generate")');

    // Wait for image generation and get URL
    const imageElement = await fluxPage.waitForSelector('img.generated-image', { timeout: 60000 });
    if (!imageElement) {
        await fluxPage.close();
        throw new Error("Image generation failed: Image element not found. CAPTCHA might not have been solved in time.");
    }
    const imgSrc = await imageElement.evaluate((el: HTMLImageElement) => el.src);

    // Determine file name
    const fileName = `flux-${seed}-${Date.now()}.jpg`;
    const targetPath = `src/generated-images/instagram-posts/current/${fileName}`;

    // Download the image using a Promise wrapper to await completion
    await new Promise<void>((resolve, reject) => {
        download(imgSrc, targetPath, (err?: Error) => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });

    await fluxPage.close();
    return targetPath;
}
