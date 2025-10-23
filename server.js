const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const cron = require("node-cron");

const app = express();
const PORT = process.env.PORT || 3000;

// JSON storage file for receipts
const receiptsFile = path.join(__dirname, "receipts.json");

// Middleware
app.use(bodyParser.json());
app.use(
  cors({
    origin: "https://test-vlkt.onrender.com", // ✅ your frontend
  })
);

// --- Helpers for receipts ---
function readReceipts() {
  if (!fs.existsSync(receiptsFile)) return {};
  return JSON.parse(fs.readFileSync(receiptsFile));
}
function writeReceipts(data) {
  fs.writeFileSync(receiptsFile, JSON.stringify(data, null, 2));
}
function formatPhone(phone) {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 9 && digits.startsWith("7")) return "254" + digits;
  if (digits.length === 10 && digits.startsWith("07"))
    return "254" + digits.substring(1);
  if (digits.length === 12 && digits.startsWith("254")) return digits;
  return null;
}

// --- 1️⃣ Initiate Payment ---
app.post("/pay", async (req, res) => {
  try {
    const { phone, amount, loan_amount } = req.body;
    const formattedPhone = formatPhone(phone);
    if (!formattedPhone)
      return res.status(400).json({ success: false, error: "Invalid phone format" });
    if (!amount || amount < 1)
      return res.status(400).json({ success: false, error: "Amount must be >= 1" });

    const reference = "ORDER-" + Date.now();

    // ✅ PayNecta payload
    const payload = {
      amount: Math.round(amount),
      phone_number: formattedPhone,
      external_reference: reference,
      customer_name: "Swift Applicant",
      callback_url: "https://paynecta.onrender.com/callback",
      channel_id: "000174",
    };

    const url = "https://paynecta.co.ke/api/v1/payment/initialize"; // ✅ PayNecta endpoint
    const resp = await axios.post(url, payload, {
      headers: {
        "X-API-Key": "YOUR_PAYNECTA_API_KEY", // ⚠️ Replace with your real key
        "X-User-Email": "YOUR_REGISTERED_EMAIL",
        "Content-Type": "application/json",
      },
    });

    console.log("PayNecta response:", resp.data);

    let receipts = readReceipts();

    if (resp.data.success) {
      const receiptData = {
        reference,
        transaction_id: resp.data.transaction_id || null,
        transaction_code: null,
        amount: Math.round(amount),
        loan_amount: loan_amount || "50000",
        phone: formattedPhone,
        customer_name: "N/A",
        status: "pending",
        status_note: `STK push sent to ${formattedPhone}. Please enter your M-Pesa PIN to complete the payment.`,
        timestamp: new Date().toISOString(),
      };

      receipts[reference] = receiptData;
      writeReceipts(receipts);

      res.json({
        success: true,
        message: "STK push sent, check your phone",
        reference,
        receipt: receiptData,
      });
    } else {
      throw new Error(resp.data.message || "Failed to initialize payment");
    }
  } catch (err) {
    console.error("Payment initiation error:", err.response?.data || err.message);
    const reference = "ORDER-" + Date.now();

    const { phone, amount, loan_amount } = req.body;
    const formattedPhone = formatPhone(phone);

    const errorReceipt = {
      reference,
      transaction_id: null,
      amount,
      loan_amount: loan_amount || "50000",
      phone: formattedPhone,
      status: "error",
      status_note: "System error occurred. Please try again later.",
      timestamp: new Date().toISOString(),
    };

    let receipts = readReceipts();
    receipts[reference] = errorReceipt;
    writeReceipts(receipts);

    res.status(500).json({ success: false, error: err.message, receipt: errorReceipt });
  }
});

// --- 2️⃣ Callback ---
app.post("/callback", (req, res) => {
  console.log("Callback received:", req.body);

  const data = req.body;
  const ref = data.external_reference;
  let receipts = readReceipts();
  const existing = receipts[ref] || {};

  if (data.status === "success" || data.resultCode === 0) {
    receipts[ref] = {
      ...existing,
      status: "processing",
      transaction_id: data.transaction_id,
      transaction_code: data.transaction_code || null,
      customer_name: data.customer_name || "N/A",
      status_note: `✅ Payment received and verified. Funds reserved for disbursement.`,
      timestamp: new Date().toISOString(),
    };
  } else {
    receipts[ref] = {
      ...existing,
      status: "cancelled",
      status_note: data.message || "Payment failed or was cancelled.",
      timestamp: new Date().toISOString(),
    };
  }

  writeReceipts(receipts);
  res.json({ ResultCode: 0, ResultDesc: "OK" });
});

// --- 3️⃣ Fetch receipt ---
app.get("/receipt/:reference", (req, res) => {
  const receipts = readReceipts();
  const receipt = receipts[req.params.reference];
  if (!receipt)
    return res.status(404).json({ success: false, error: "Receipt not found" });
  res.json({ success: true, receipt });
});

// --- 4️⃣ PDF Receipt ---
app.get("/receipt/:reference/pdf", (req, res) => {
  const receipts = readReceipts();
  const receipt = receipts[req.params.reference];
  if (!receipt)
    return res.status(404).json({ success: false, error: "Receipt not found" });
  generateReceiptPDF(receipt, res);
});

function generateReceiptPDF(receipt, res) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename=receipt-${receipt.reference}.pdf`
  );

  const doc = new PDFDocument({ margin: 50 });
  doc.pipe(res);

  let headerColor = "#2196F3";
  let watermarkText = "PENDING";
  let watermarkColor = "gray";

  if (receipt.status === "processing") {
    watermarkText = "PROCESSING";
    watermarkColor = "blue";
  } else if (receipt.status === "loan_released") {
    watermarkText = "RELEASED";
    watermarkColor = "green";
  } else if (receipt.status === "cancelled") {
    watermarkText = "FAILED";
    watermarkColor = "red";
  }

  doc.rect(0, 0, doc.page.width, 80).fill(headerColor);
  doc.fillColor("white").fontSize(24).text("PayNecta Loan Receipt", 50, 25);
  doc.moveDown(3);
  doc.fillColor("black").fontSize(14).text("Receipt Details", { underline: true });
  doc.moveDown();

  const details = [
    ["Reference", receipt.reference],
    ["Amount", `KSH ${receipt.amount}`],
    ["Loan Amount", `KSH ${receipt.loan_amount}`],
    ["Phone", receipt.phone],
    ["Status", receipt.status.toUpperCase()],
    ["Time", new Date(receipt.timestamp).toLocaleString()],
  ];

  details.forEach(([k, v]) => {
    doc.fontSize(12).text(`${k}: ${v}`);
  });

  if (receipt.status_note) {
    doc.moveDown().fillColor("#555").text(receipt.status_note);
  }

  doc.fontSize(50).fillColor(watermarkColor).opacity(0.2).text(watermarkText, 150, 400);
  doc.end();
}

// --- 5️⃣ Cron Job: release loans after 24 hours ---
cron.schedule("*/5 * * * *", () => {
  let receipts = readReceipts();
  const now = Date.now();

  for (const ref in receipts) {
    const r = receipts[ref];
    if (r.status === "processing") {
      const releaseTime =
        new Date(r.timestamp).getTime() + 24 * 60 * 60 * 1000;
      if (now >= releaseTime) {
        r.status = "loan_released";
        r.status_note = "Loan has been released to your account.";
        console.log(`✅ Released loan for ${ref}`);
      }
    }
  }

  writeReceipts(receipts);
});

// --- Start server ---
app.listen(PORT, () => {
  console.log(`🚀 PayNecta server running on port ${PORT}`);
});
