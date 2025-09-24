require("dotenv").config();
const { Builder, By, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

const service = new chrome.ServiceBuilder(require("chromedriver").path);

const LOGIN_ID = process.env.ID;
const LOGIN_PW = process.env.PW;
const LOGIN2_URL = process.env.LOGIN2_URL;
const TARGET2_URL = process.env.TARGET2_URL;
const BASE2_URL = process.env.BASE2_URL;

function toAbsoluteUrl(u) {
  if (!u) return "";
  if (u.startsWith("//")) return "https:" + u;
  if (u.startsWith("/")) return BASE2_URL + u;
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

function parsePrice(str) {
  if (!str) return 0;
  const num = str.replace(/[^0-9]/g, "");
  return num ? parseInt(num, 10) : 0;
}

async function crawlProduct() {
  const driver = await new Builder()
    .forBrowser("chrome")
    .setChromeService(service)
    .build();

  try {
    await driver.get(LOGIN2_URL);
    await driver.findElement(By.name("m_id")).sendKeys(LOGIN_ID);
    await driver.findElement(By.name("password")).sendKeys(LOGIN_PW);
    await driver
      .findElement(By.css("input[type='image'][src*='btn_login.gif']"))
      .click();
    await driver.sleep(2000);

    let page = 1;
    let hasNext = true;

    while (hasNext) {
      const url = `${TARGET2_URL}&page=${page}`;
      await driver.get(url);
      await driver.sleep(800);

      const products = await driver.findElements(By.css(".goodsList"));
      console.log(`[페이지 ${page}] 상품 개수: ${products.length}`);
      if (products.length === 0) {
        hasNext = false;
        break;
      }

      const productLinks = [];
      for (let p of products) {
        const image = await p
          .findElement(By.css(".goodsImg img"))
          .getAttribute("src");
        const nameElement = await p.findElement(By.css(".goodsnm a"));
        const name = await nameElement.getText();
        const detailUrl = toAbsoluteUrl(await nameElement.getAttribute("href"));
        const code = await p.findElement(By.css(".goodscd")).getText();
        const price = await p.findElement(By.css(".goodsPrice")).getText();
        productLinks.push({ name, price, image, detailUrl, code });
      }

      for (let prod of productLinks) {
        const { name, price, image, detailUrl, code } = prod;

        const baseDir = path.join(__dirname, name);
        const detailDir = path.join(baseDir, "상세정보사진");
        if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
        if (!fs.existsSync(detailDir))
          fs.mkdirSync(detailDir, { recursive: true });

        await downloadImage(image, path.join(baseDir, "대표이미지.jpg"));
        await saveTextFile(path.join(baseDir, "상품명.text"), name);
        await saveTextFile(path.join(baseDir, "가격.text"), price);

        await driver.get(detailUrl);
        await driver.sleep(800);

        let deliveryPrice = 0;
        try {
          const deliveryElement = await driver.findElement(
            By.xpath(
              "//li[contains(@class,'cont_title') and contains(text(),'배송비')]/following-sibling::li[@class='cont_desc']"
            )
          );
          const desc = (await deliveryElement.getText()).trim();
          deliveryPrice = parseInt(desc.replace(/[^0-9]/g, ""), 10);
        } catch (err) {
          deliveryPrice = 0;
        }

        const returnPrice = deliveryPrice;
        const changePrice = deliveryPrice * 2;

        let option_comb_list = [];
        let option_info_list = [];
        try {
          const selectEl = await driver.findElement(
            By.css("select[name='opt[]']")
          );
          const options = await selectEl.findElements(By.css("option"));
          const body = [];
          for (let opt of options) {
            const value = await opt.getAttribute("value");
            const text = (await opt.getText()).trim();
            if (!value || value === "" || text.includes("==")) continue;
            const pathVal = `${code}:${text}`;
            body.push({
              path: pathVal,
              name: text,
              img: "",
              is_soldout: false,
            });
            option_comb_list.push({
              path: pathVal,
              price: 0,
              img: "",
              is_soldout: false,
            });
          }
          if (body.length > 0) {
            option_info_list.push({ title: "구성", body });
          }
        } catch {}

        for (let s = 0; s < 8; s++) {
          await driver.executeScript("window.scrollBy(0, window.innerHeight)");
          await driver.sleep(200);
        }

        const detailSrcs = await driver.executeScript(() => {
          const pick = (img) =>
            img.getAttribute("src") || img.getAttribute("data-src") || "";
          const nodes = document.querySelectorAll(
            "center[style*='1120px'] img"
          );
          const urls = Array.from(nodes).map(pick).filter(Boolean);
          return Array.from(new Set(urls));
        });

        let idx = 1;
        for (const src of detailSrcs) {
          const abs = src.startsWith("http") ? src : location.origin + src;
          await downloadImage(
            abs,
            path.join(detailDir, `상세이미지_${idx}.jpg`)
          );
          idx++;
        }

        console.log(`${name} 처리 완료 (상세이미지 ${idx - 1}개 저장)`);

        const productInfoJson = {
          idx: page,
          product_id: code,
          origin_path: detailUrl,
          product_name: name,
          product_price: parsePrice(price),
          product_origin_price: parsePrice(price),
          product_minimum_price: parsePrice(price),
          currency_unit: "원",
          delivery_price: deliveryPrice,
          return_price: returnPrice,
          change_price: changePrice,
          option_comb_list,
          option_info_list,
          keyword_list: [],
          thumbnail_img: image,
          main_img: image,
          product_img_list: [image],
          product_info_img_list: detailSrcs.map((src) => toAbsoluteUrl(src)),
          state: 0,
          is_discount: 0,
          is_soldout: 0,
          is_img_save: 0,
          discount_per: 0,
          delivery_info: "",
        };

        await saveTextFile(
          path.join(baseDir, "productInfo.text"),
          JSON.stringify(productInfoJson, null, 2)
        );
      }

      page++;
    }
  } catch (err) {
    console.error("크롤링 실패:", err);
  } finally {
    await driver.quit();
  }
}

crawlProduct();
