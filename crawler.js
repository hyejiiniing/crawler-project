require("dotenv").config();
const { Builder, By, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");
const knex = require("knex");
const knexConfig = require("./knexfile.js");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

const service = new chrome.ServiceBuilder(require("chromedriver").path);

const LOGIN_ID = process.env.CHOITEM_ID;
const LOGIN_PW = process.env.CHOITEM_PW;
const LOGIN_URL = process.env.LOGIN_URL;
const TARGET_URL = process.env.CHOITEM_URL;

const db = knex(knexConfig.development);

function slugify(text) {
  return text
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9가-힣]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .trim();
}

function toAbsoluteUrl(u) {
  if (!u) return "";
  if (u.startsWith("//")) return "https:" + u;
  if (u.startsWith("/")) return "https://choitemb2b.com" + u;
  if (u.startsWith("http:")) return u.replace(/^http:/, "https:");
  return u;
}

function saveResponse(res, filepath, resolve, reject) {
  if (res.statusCode === 200) {
    const fileStream = fs.createWriteStream(filepath);
    res.pipe(fileStream);
    fileStream.on("finish", () => {
      fileStream.close();
      resolve(filepath);
    });
  } else {
    reject(`이미지 다운로드 실패: ${res.statusCode}`);
  }
}

async function downloadImage(url, filepath) {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(filepath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    url = toAbsoluteUrl(url);

    if (url.startsWith("https://")) {
      https
        .get(url, (res) => saveResponse(res, filepath, resolve, reject))
        .on("error", reject);
    } else if (url.startsWith("http://")) {
      http
        .get(url, (res) => saveResponse(res, filepath, resolve, reject))
        .on("error", reject);
    } else if (url.startsWith("data:image")) {
      const base64Data = url.split(",")[1] || "";
      fs.writeFileSync(filepath, Buffer.from(base64Data, "base64"));
      resolve(filepath);
    } else {
      resolve(null);
    }
  });
}

async function saveTextFile(filepath, content) {
  const dir = path.dirname(filepath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filepath, content ?? "", "utf-8");
}

async function crawlProduct() {
  const driver = await new Builder()
    .forBrowser("chrome")
    .setChromeService(service)
    .build();

  try {
    await driver.get("https://choitemb2b.com/member/login.html");
    await driver.findElement(By.name("member_id")).sendKeys(LOGIN_ID);
    await driver.findElement(By.name("member_passwd")).sendKeys(LOGIN_PW);
    await driver.wait(
      until.elementLocated(By.css("a.-btn.-block.-xl.-black")),
      5000
    );
    await driver.findElement(By.css("a.-btn.-block.-xl.-black")).click();
    await driver.sleep(2000);

    let page = 1;
    let hasNext = true;

    while (hasNext) {
      const url = `${TARGET_URL}&page=${page}`;
      await driver.get(url);
      await driver.sleep(800);

      const products = await driver.findElements(By.css(".prdList .item"));
      console.log(`[페이지 ${page}] 상품 개수: ${products.length}`);
      if (products.length === 0) {
        hasNext = false;
        break;
      }

      const productLinks = [];
      for (let p of products) {
        const nameElement = await p.findElement(By.css("p.name a"));
        const rawName = await nameElement.getAttribute("textContent");
        const name = rawName.replace("상품명 :", "").trim();
        const safeName = name;

        let price = "";
        try {
          const priceElement = await p.findElement(
            By.css("li.xans-record- > span[style*='font-size']")
          );
          price = (await priceElement.getText()).trim();
        } catch {}

        let image = await p
          .findElement(By.css("img[id^='eListPrdImage']"))
          .getAttribute("src");
        image = toAbsoluteUrl(image);

        let detailUrl = await nameElement.getAttribute("href");
        detailUrl = toAbsoluteUrl(detailUrl);

        productLinks.push({ name, safeName, price, image, detailUrl });
      }

      for (let prod of productLinks) {
        const { name, safeName, price, image, detailUrl } = prod;

        const baseDir = path.join(__dirname, safeName);
        const detailDir = path.join(baseDir, "상세정보사진");
        if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
        if (!fs.existsSync(detailDir))
          fs.mkdirSync(detailDir, { recursive: true });

        await downloadImage(image, path.join(baseDir, "대표이미지.jpg"));

        await saveTextFile(path.join(baseDir, "상품명.text"), name);
        await saveTextFile(path.join(baseDir, "가격.text"), price);

        await driver.get(detailUrl);
        await driver.sleep(800);

        try {
          await driver.wait(
            until.elementLocated(
              By.css("#prdDetail, .edibot-product, .cont, .xans-product-detail")
            ),
            5000
          );
        } catch {}

        for (let s = 0; s < 8; s++) {
          await driver.executeScript("window.scrollBy(0, window.innerHeight)");
          await driver.sleep(200);
        }

        const detailSrcs = await driver.executeScript(() => {
          const pick = (img) =>
            img.getAttribute("src") || img.getAttribute("data-src") || "";
          const nodes = document.querySelectorAll(
            "#prdDetail img, .edibot-product img, .cont img, .xans-product-detail img"
          );
          const urls = Array.from(nodes)
            .map(pick)
            .filter(Boolean)
            .filter((src) => src.includes("/web/upload/NNEditor/"));
          return Array.from(new Set(urls));
        });

        let idx = 1;
        for (const src of detailSrcs) {
          const abs = toAbsoluteUrl(src);
          await downloadImage(
            abs,
            path.join(detailDir, `상세이미지_${idx}.jpg`)
          );
          idx++;
        }

        console.log(`${name} 처리 완료 (상세이미지 ${idx - 1}개 저장)`);

        await db("products").insert({ name, price, image_url: image });
      }

      page++;
    }
  } catch (err) {
    console.error("크롤링 실패:", err);
  } finally {
    await driver.quit();
    await db.destroy();
  }
}

crawlProduct();
