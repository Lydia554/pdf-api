const express = require("express");
const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const pdfParse = require("pdf-parse");
const ShopConfig = require("../models/ShopConfig");
const User = require("../models/User"); 
const authenticate = require("../middleware/authenticate"); 
const dualAuth = require("../middleware/dualAuth");
const {resolveShopifyToken} = require("../utils/shopifyHelpers");

const router = express.Router();
require('dotenv').config();


function generateInvoiceHTML(invoiceData, isPremium) {
  const premium = FORCE_PREMIUM || isPremium;

  const { shopName, date, items, total, showChart, customLogoUrl, fallbackLogoUrl } = invoiceData;

  const basicTemplate = `
    <html>
      <head><meta charset="UTF-8" /><title>Invoice</title></head>
      <body style="font-family: sans-serif;">
        <h1>Invoice</h1>
        <p><strong>From:</strong> ${shopName}</p>
        <p><strong>Date:</strong> ${date}</p>
        <table border="1" cellpadding="10" cellspacing="0" width="100%">
          <thead><tr><th>Item</th><th>Qty</th><th>Price</th></tr></thead>
          <tbody>
            ${items.map(item => `
              <tr>
                <td>${item.name}</td>
                <td>${item.quantity}</td>
                <td>$${item.price.toFixed(2)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
        <h3>Total: $${total.toFixed(2)}</h3>
      </body>
    </html>
  `;

  const premiumTemplate = `
    <html>
      <head>
        <meta charset="UTF-8" />
        <title>Invoice</title>
        <style>
          @import url('https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;600;700&display=swap');
          @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600&display=swap');
          body {
            font-family: 'Open Sans', sans-serif;
            color: #333;
            background: #f4f7fb;
            margin: 0;
            padding: 0;
          }
          .container {
            max-width: 800px;
            margin: 20px auto;
            padding: 30px 40px 160px;
            background: linear-gradient(to bottom right, #ffffff, #f8fbff);
            box-shadow: 0 8px 25px rgba(0, 0, 0, 0.08);
            border-radius: 16px;
          }
          .logo {
            width: 150px;
            margin-bottom: 20px;
          }
          h1 {
            font-family: 'Playfair Display', serif;
            font-size: 32px;
            color: #2a3d66;
            text-align: center;
          }
          .invoice-header {
            display: flex;
            justify-content: space-between;
            margin-bottom: 30px;
            padding-bottom: 20px;
            border-bottom: 2px solid #4a69bd;
          }
          .table {
            width: 100%;
            border-collapse: collapse;
          }
          .table th,
          .table td {
            padding: 14px;
            border: 1px solid #dee2ef;
            vertical-align: middle;
          }
          .table th {
            background-color: #dbe7ff;
          }
          .product-image {
            width: 60px;
            height: 60px;
            object-fit: contain;
            border-radius: 8px;
            border: 1px solid #ccc;
            background: white;
          }
          .total {
            text-align: right;
            font-size: 20px;
            font-weight: bold;
            margin-top: 20px;
          }
          .chart-container {
            margin-top: 30px;
            text-align: center;
          }
          .footer {
            max-width: 800px;
            margin: 40px auto 10px auto;
            padding: 10px 20px;
            background-color: #f0f2f7;
            color: #555;
            text-align: center;
            font-size: 11px;
            border-top: 2px solid #cbd2e1;
            border-radius: 0 0 16px 16px;
            position: static;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <img src="${customLogoUrl || fallbackLogoUrl}" class="logo" />
          <h1>Invoice</h1>
          <div class="invoice-header">
            <div><strong>From:</strong><br>${shopName}</div>
            <div><strong>Date:</strong><br>${date}</div>
          </div>
          <table class="table">
            <thead>
              <tr>
                <th>Image</th>
                <th>Item</th>
                <th>Qty</th>
                <th>Price</th>
              </tr>
            </thead>
            <tbody>
              ${items.map(item => `
                <tr>
                  <td>${item.imageUrl ? `<img src="${item.imageUrl}" class="product-image" />` : ""}</td>
                  <td>${item.name}</td>
                  <td>${item.quantity}</td>
                  <td>$${item.price.toFixed(2)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
          <div class="total">Total: $${total.toFixed(2)}</div>

          ${showChart ? `<div class="chart-container"><h2>Spending Overview</h2><img src="https://via.placeholder.com/400x200?text=Chart" /></div>` : ""}
        </div>
        <div class="footer">
          <p>This invoice was automatically generated by PDFify for Shopify</p>
          <p><a href="https://pdfify.pro/">Visit our site</a></p>
        </div>
      </body>
    </html>
  `;

  return premium ? premiumTemplate : basicTemplate;
}






router.post("/invoice", authenticate, dualAuth, async (req, res) => {
  try {
    const shopDomain = req.body.shopDomain || req.headers["x-shopify-shop-domain"];
    if (!shopDomain) return res.status(400).json({ error: "Missing shop domain" });

    const token = await resolveShopifyToken(req, shopDomain);
    if (!token) return res.status(400).json({ error: "Missing Shopify access token" });

    let orderId = req.body.orderId;
    let order = req.body.order || null;

    if (typeof orderId === "string" && orderId.startsWith("gid://")) {
      orderId = orderId.split("/").pop();
    }

    if (!order && orderId) {
      const shopifyOrderUrl = `https://${shopDomain}/admin/api/2023-10/orders/${orderId}.json`;
      try {
        const orderResponse = await axios.get(shopifyOrderUrl, {
          headers: {
            "X-Shopify-Access-Token": token,
            "Content-Type": "application/json",
          },
        });
        order = orderResponse.data.order;
      } catch (err) {
        console.error("❌ Failed to fetch order from Shopify:", err.response?.data || err.message);
        return res.status(500).json({ error: "Failed to fetch order from Shopify" });
      }
    }

    if (!order || !order.line_items) {
      return res.status(400).json({ error: "Invalid or missing order data" });
    }

    if (!orderId && order?.id) {
      orderId = order.id;
    }

    let user = req.user?.userId
      ? await User.findById(req.user.userId)
      : await User.findOne({ connectedShopDomain: shopDomain });

    if (!user) return res.status(404).json({ error: "User not found for this shop" });

    const shopConfig = await ShopConfig.findOne({ shopDomain }) || {};
    const isPreview = req.query.preview === "true";
    const isPremium = true; 


const enrichedItems = order.line_items;


    const invoiceData = {
      shopName: shopConfig?.shopName || shopDomain || "Unnamed Shop",
      date: new Date(order.created_at).toISOString().slice(0, 10),
      items: enrichedItems,
      total: Number(order.total_price) || 0,
      showChart: isPremium && shopConfig?.showChart,
      customLogoUrl: isPremium ? shopConfig?.customLogoUrl : null,
      fallbackLogoUrl: "/assets/default-logo.png",
    };

    const safeOrderId = `shopify-${order.id}`;
    const pdfDir = path.join(__dirname, "../pdfs");
    if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir);

    const pdfPath = path.join(pdfDir, `Invoice_${safeOrderId}.pdf`);
    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();

    const html = generateInvoiceHTML(invoiceData, isPremium);
    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.pdf({ path: pdfPath, format: "A4" });
    await browser.close();

    const pdfBuffer = fs.readFileSync(pdfPath);
    const parsed = await pdfParse(pdfBuffer);
    const pageCount = parsed.numpages;

    if (!isPreview) {
      if (user.usageCount + pageCount > user.maxUsage) {
        fs.unlinkSync(pdfPath);
        return res.status(403).json({
          error: "Monthly usage limit reached. Upgrade to premium for more pages.",
        });
      }
      user.usageCount += pageCount;
      await user.save();
    }

    try {
      if (order.email) {
        await sendEmailWithAttachment({
          to: order.email,
          subject: `Your Invoice from ${invoiceData.shopName}`,
          text: "Please find your invoice attached.",
          attachments: [
            {
              filename: `Invoice_${safeOrderId}.pdf`,
              content: pdfBuffer,
            },
          ],
        });
        console.log("✅ Invoice emailed to:", order.email);
      } else {
        console.warn("⚠️ No email found on order, skipping email");
      }
    } catch (emailErr) {
      console.error("❌ Failed to send invoice email:", emailErr);
    }

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": isPreview
        ? "inline"
        : `attachment; filename=Invoice_${safeOrderId}.pdf`,
    });
    res.send(pdfBuffer);

    fs.unlinkSync(pdfPath);
  } catch (error) {
    console.error("❌ Shopify invoice generation error:", error);
    res.status(500).json({ error: "PDF generation failed" });
  }
});






router.get("/connection", authenticate, dualAuth, async (req, res) => {

  try {
    const connectedShopDomain = req.fullUser.connectedShopDomain || null;
    res.json({ connectedShopDomain });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch Shopify connection" });
  }
});


router.post("/connect", authenticate, dualAuth, async (req, res) => {
  try {
    const { shopDomain, accessToken } = req.body;

    if (!shopDomain || !accessToken) {
      return res.status(400).json({ error: "Shop domain and access token required" });
    }

    const normalizedShopDomain = shopDomain.toLowerCase();


    req.fullUser.connectedShopDomain = normalizedShopDomain;
    req.fullUser.shopifyAccessToken = accessToken;
    await req.fullUser.save();

    res.json({ message: `Shopify store ${normalizedShopDomain} connected successfully.` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to connect Shopify store" });
  }
});

router.post("/disconnect", authenticate, dualAuth, async (req, res) => {
  try {
    req.fullUser.connectedShopDomain = null;
    req.fullUser.shopifyAccessToken = null;
    await req.fullUser.save();
    res.json({ message: "Shopify store disconnected successfully." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to disconnect Shopify store" });
  }
});


module.exports = router;