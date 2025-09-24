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
const LOGIN_URL = process.env.LOGIN_URL;
const TARGET_URL = process.env.TARGET_URL;
const BASE_URL = process.env.BASE_URL;

function toAbsoluteUrl(u) {
  if (!u) return "";
  if (u.startsWith("//")) return "https:" + u;
  if (u.startsWith("/")) return BASE_URL + u;
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
    // 로그인
    await driver.get(LOGIN_URL);
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

        productLinks.push({ name, price, image, detailUrl });
      }

      for (let prod of productLinks) {
        const { name, price, image, detailUrl } = prod;

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

        let productId = "";
        try {
          const idElement = await driver.findElement(
            By.xpath(
              "//th[span[text()='자체상품코드']]/following-sibling::td/span"
            )
          );
          productId = (await idElement.getText()).trim();
        } catch {
          productId = "";
        }

        let deliveryPrice = 0;
        try {
          const deliveryElement = await driver.findElement(
            By.css(".delv_price_B strong")
          );
          const dp = (await deliveryElement.getText()).trim();
          deliveryPrice = parseInt(dp.replace(/[^0-9]/g, ""), 10);
        } catch {
          deliveryPrice = 0;
        }

        const returnPrice = deliveryPrice;
        const changePrice = deliveryPrice * 2;

        let optionCombList = [];
        let optionInfoList = [];
        try {
          const selects = await driver.findElements(
            By.css("select[option_product_no]")
          );
          for (let sel of selects) {
            const productNo = await sel.getAttribute("option_product_no");
            const title = (await sel.getAttribute("option_title")) || "옵션";
            const options = await sel.findElements(By.css("option"));
            const bodyList = [];

            for (let opt of options) {
              const value = await opt.getAttribute("value");
              const disabled = await opt.getAttribute("disabled");
              if (!value || value === "*" || value === "**" || disabled)
                continue;

              let optName = (await opt.getText()).trim();
              let addPrice = 0;
              const match = optName.match(/\(\s*\+?([\d,]+)원\s*\)/);
              if (match) {
                addPrice = parseInt(match[1].replace(/,/g, ""), 10);
              }

              const cleanName = optName.replace(/\s*\(\+?.*원\)/, "");
              const pathKey = `${productNo}:${cleanName}`;

              optionCombList.push({
                path: pathKey,
                price: addPrice,
                img: "",
                is_soldout: false,
              });

              bodyList.push({
                path: pathKey,
                name: optName,
                img: "",
                is_soldout: false,
              });
            }

            if (bodyList.length > 0) {
              optionInfoList.push({
                title,
                body: bodyList,
              });
            }
          }
        } catch (e) {
          console.log("옵션 없음:", e.message);
        }

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

        const productInfoJson = {
          idx: page,
          product_id: productId,
          origin_path: detailUrl,
          product_name: name,
          product_price: parseInt(price.replace(/[^0-9]/g, ""), 10) || 0,
          product_origin_price: parseInt(price.replace(/[^0-9]/g, ""), 10) || 0,
          product_minimum_price:
            parseInt(price.replace(/[^0-9]/g, ""), 10) || 0,
          currency_unit: "원",
          delivery_price: deliveryPrice,
          return_price: returnPrice,
          change_price: changePrice,
          option_comb_list: optionCombList,
          option_info_list: optionInfoList,
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
