import PDFDocument from "pdfkit";

/**
 * Streams a Gaznger order receipt as a PDF buffer to the given writable
 * stream. Pure layout — caller wires the model lookups and route.
 *
 * Brand-aligned: green primary (#1A7F4F), Helvetica fallback (PDFKit
 * doesn't ship Nunito), tabular numbers via fixed font for amounts.
 */

interface ReceiptInput {
  orderId: string;
  orderShortId: string;
  fuelLine: string;
  stationName: string;
  deliveryAddressLine: string;
  paymentMethodLabel: string;
  totalCharged: number;
  fuelCost: number;
  deliveryFee: number;
  pointsEarned: number;
  ratedAt?: Date | null;
  deliveredAt?: Date | null;
  customerName: string;
  customerEmail: string;
  weighIn?: { emptyKg: number; fullKg: number; netKg: number } | null;
}

const NGN = (n: number) =>
  `NGN ${n.toLocaleString("en-NG", { maximumFractionDigits: 0 })}`;

export function streamReceiptPdf(
  data: ReceiptInput,
  out: NodeJS.WritableStream
): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 56, bottom: 56, left: 56, right: 56 },
      info: {
        Title: `Gaznger receipt — ${data.orderShortId}`,
        Author: "Gaznger",
        Subject: "Order receipt",
      },
    });
    doc.on("end", () => resolve());
    doc.on("error", (err) => reject(err));
    doc.pipe(out);

    // ── Header ─────────────────────────────────────────────────────
    doc.fillColor("#1A7F4F").fontSize(28).font("Helvetica-Bold").text("Gaznger");
    doc
      .fillColor("#6B7672")
      .fontSize(10)
      .font("Helvetica")
      .text("Logistical clarity, financially trusted.")
      .moveDown(1.5);

    // ── Order title ────────────────────────────────────────────────
    doc
      .fillColor("#0C1812")
      .fontSize(18)
      .font("Helvetica-Bold")
      .text(`Order #${data.orderShortId}`);
    if (data.deliveredAt) {
      doc
        .fillColor("#6B7672")
        .fontSize(10)
        .font("Helvetica")
        .text(
          `Delivered ${new Date(data.deliveredAt).toLocaleString("en-NG", {
            day: "numeric",
            month: "short",
            year: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}`
        );
    }
    doc.moveDown(1.5);

    // ── Customer block ─────────────────────────────────────────────
    section(doc, "BILLED TO");
    row(doc, data.customerName);
    row(doc, data.customerEmail, "#6B7672");
    doc.moveDown(0.5);
    row(doc, data.deliveryAddressLine, "#6B7672");
    doc.moveDown(1.5);

    // ── Receipt body ───────────────────────────────────────────────
    section(doc, "RECEIPT");
    receiptRow(doc, "Fuel", data.fuelLine);
    receiptRow(doc, "Station", data.stationName);
    if (data.weighIn) {
      receiptRow(
        doc,
        "Weighed at station",
        `${data.weighIn.emptyKg}kg empty · ${data.weighIn.fullKg}kg full · ${data.weighIn.netKg}kg net`
      );
    }
    receiptRow(doc, "Paid with", data.paymentMethodLabel);
    doc.moveDown(0.5);

    // ── Totals ─────────────────────────────────────────────────────
    moneyRow(doc, "Subtotal", NGN(data.fuelCost));
    moneyRow(doc, "Delivery fee", NGN(data.deliveryFee));
    divider(doc);
    moneyRow(doc, "Total paid", NGN(data.totalCharged), true);
    doc.moveDown(1.5);

    // ── Points earned ──────────────────────────────────────────────
    if (data.pointsEarned > 0) {
      doc
        .roundedRect(56, doc.y, 480, 44, 8)
        .fillAndStroke("#FEF7D6", "#F8D24D");
      doc
        .fillColor("#6B5306")
        .fontSize(11)
        .font("Helvetica-Bold")
        .text(`+${data.pointsEarned} Gaznger points earned`, 72, doc.y - 32);
      doc
        .fillColor("#6B5306")
        .fontSize(9)
        .font("Helvetica")
        .text("Apply on your next order at checkout.", 72, doc.y + 1);
      doc.moveDown(2);
    }

    // ── Footer ─────────────────────────────────────────────────────
    doc
      .fillColor("#98A29E")
      .fontSize(8)
      .font("Helvetica")
      .text(
        "Gaznger · Lagos, Nigeria · support@gaznger.com",
        56,
        doc.page.height - 72,
        { width: 480, align: "center" }
      );

    doc.end();
  });
}

function section(doc: PDFKit.PDFDocument, label: string) {
  doc
    .fillColor("#98A29E")
    .fontSize(9)
    .font("Helvetica-Bold")
    .text(label, { characterSpacing: 1.5 })
    .moveDown(0.4);
}

function row(doc: PDFKit.PDFDocument, text: string, color = "#0C1812") {
  doc.fillColor(color).fontSize(11).font("Helvetica").text(text);
}

function receiptRow(doc: PDFKit.PDFDocument, label: string, value: string) {
  const x = 56;
  const y = doc.y;
  doc.fillColor("#6B7672").fontSize(10).font("Helvetica").text(label, x, y, {
    continued: false,
    width: 200,
  });
  doc
    .fillColor("#0C1812")
    .fontSize(11)
    .font("Helvetica")
    .text(value, x + 200, y, { width: 280, align: "right" });
  doc.moveDown(0.5);
}

function moneyRow(
  doc: PDFKit.PDFDocument,
  label: string,
  value: string,
  bold = false
) {
  const x = 56;
  const y = doc.y;
  doc
    .fillColor(bold ? "#0C1812" : "#6B7672")
    .fontSize(bold ? 13 : 11)
    .font(bold ? "Helvetica-Bold" : "Helvetica")
    .text(label, x, y);
  doc
    .fillColor("#0C1812")
    .fontSize(bold ? 14 : 11)
    .font(bold ? "Helvetica-Bold" : "Helvetica")
    .text(value, x + 200, y, { width: 280, align: "right" });
  doc.moveDown(0.5);
}

function divider(doc: PDFKit.PDFDocument) {
  const y = doc.y + 4;
  doc.strokeColor("#DDE2E0").lineWidth(0.5).moveTo(56, y).lineTo(536, y).stroke();
  doc.moveDown(0.6);
}
