const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const storage = require("./storageService");
const { DOCUMENT_LABELS, ALL_DRIVER_DOCUMENTS } = require("../constants/documents");

// A4 in PDF points
const A4 = [595.28, 841.89];
const MARGIN = 40;

const INK = rgb(0.13, 0.13, 0.15);
const MUTED = rgb(0.45, 0.45, 0.5);
const RULE = rgb(0.85, 0.85, 0.88);

// Builds one PDF containing every current document for a driver.
//
// Images become a page each, scaled to fit. Uploaded PDFs have their pages
// copied in as they are, so a multi-page PCO counterpart stays intact.
//
// options.showStatus — include each document's review status on the cover.
//   The driver's own copy hides it (internal review state is not their
//   business, and a pack full of "pending_review" reads badly when they send
//   it on). The operator's copy shows it, since that is the point of theirs.
const buildDriverDocumentPdf = async (driver, documents, options = {}) => {
    const { showStatus = false } = options;

    // Show them in onboarding order, not alphabetically — "back" before
    // "front" makes no sense to whoever is reviewing the pack.
    const ordered = [...documents].sort((a, b) => {
        const ai = ALL_DRIVER_DOCUMENTS.indexOf(a.document_type);
        const bi = ALL_DRIVER_DOCUMENTS.indexOf(b.document_type);
        return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });

    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

    pdf.setTitle(`MoveApp documents — ${driver.first_name} ${driver.last_name}`);
    pdf.setProducer("MoveApp");
    pdf.setCreationDate(new Date());

    // ---- Cover page -------------------------------------------------------
    const cover = pdf.addPage(A4);
    const { width, height } = cover.getSize();
    let y = height - MARGIN - 20;

    cover.drawText("MoveApp", { x: MARGIN, y, size: 22, font: bold, color: INK });
    y -= 18;
    cover.drawText("Driver document pack", { x: MARGIN, y, size: 11, font, color: MUTED });

    y -= 24;
    cover.drawLine({
        start: { x: MARGIN, y }, end: { x: width - MARGIN, y },
        thickness: 1, color: RULE
    });

    y -= 32;
    const fullName = [driver.title, driver.first_name, driver.middle_name, driver.last_name]
        .filter(Boolean).join(" ");

    const rows = [
        ["Name", fullName],
        ["Email", driver.email || "—"],
        ["Phone", driver.phone || "—"],
        ["National Insurance", driver.ni_number || "—"],
        ["Postcode", driver.postcode || "—"],
        ["Driver type", driver.driver_type || "—"],
        ["Generated", new Date().toISOString().slice(0, 10)]
    ];

    // Account status belongs on the operator's copy only
    if (showStatus) rows.splice(6, 0, ["Account status", driver.status]);

    for (const [label, value] of rows) {
        cover.drawText(label, { x: MARGIN, y, size: 9, font, color: MUTED });
        cover.drawText(String(value), { x: MARGIN + 140, y, size: 11, font: bold, color: INK });
        y -= 20;
    }

    y -= 16;
    cover.drawText("Documents in this pack", { x: MARGIN, y, size: 12, font: bold, color: INK });
    y -= 8;
    cover.drawLine({
        start: { x: MARGIN, y }, end: { x: width - MARGIN, y },
        thickness: 1, color: RULE
    });
    y -= 20;

    for (const doc of ordered) {
        if (y < MARGIN + 40) break;   // one cover page is enough
        const label = DOCUMENT_LABELS[doc.document_type] || doc.document_type;
        cover.drawText(label, { x: MARGIN, y, size: 10, font, color: INK });

        if (showStatus) {
            cover.drawText(doc.status, {
                x: width - MARGIN - 90, y, size: 9, font, color: MUTED
            });
        }

        y -= 17;
    }

    // ---- One section per document ----------------------------------------
    for (const doc of ordered) {
        const label = DOCUMENT_LABELS[doc.document_type] || doc.document_type;

        let buffer;
        try {
            buffer = await storage.readBuffer(doc.storage_key);
        } catch (err) {
            addMissingPage(pdf, font, bold, label, "File could not be read");
            continue;
        }

        try {
            if (doc.file_format === "application/pdf") {
                // Copy the uploaded PDF's pages in unchanged
                const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
                const copied = await pdf.copyPages(src, src.getPageIndices());
                copied.forEach((p) => pdf.addPage(p));
            } else {
                const image = doc.file_format === "image/png"
                    ? await pdf.embedPng(buffer)
                    : await pdf.embedJpg(buffer);

                const page = pdf.addPage(A4);
                const pw = page.getWidth() - MARGIN * 2;
                const ph = page.getHeight() - MARGIN * 2 - 30;   // room for the caption

                // Fit inside the box without distorting, and never enlarge
                const scale = Math.min(pw / image.width, ph / image.height, 1);
                const w = image.width * scale;
                const h = image.height * scale;

                page.drawText(label, {
                    x: MARGIN,
                    y: page.getHeight() - MARGIN,
                    size: 11,
                    font: bold,
                    color: INK
                });

                page.drawImage(image, {
                    x: (page.getWidth() - w) / 2,
                    y: (page.getHeight() - h) / 2 - 15,
                    width: w,
                    height: h
                });
            }
        } catch (err) {
            console.error(`Could not embed document ${doc.id}:`, err.message);
            addMissingPage(pdf, font, bold, label, "File could not be embedded");
        }
    }

    return Buffer.from(await pdf.save());
};

// A readable placeholder rather than a silently missing document
const addMissingPage = (pdf, font, bold, label, reason) => {
    const page = pdf.addPage(A4);
    page.drawText(label, {
        x: MARGIN, y: page.getHeight() - MARGIN, size: 11, font: bold, color: INK
    });
    page.drawText(reason, {
        x: MARGIN, y: page.getHeight() / 2, size: 10, font, color: MUTED
    });
};

module.exports = { buildDriverDocumentPdf };