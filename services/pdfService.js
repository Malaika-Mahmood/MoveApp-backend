const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const storage = require("./storageService");
const {
    DOCUMENT_LABELS,
    ALL_DRIVER_DOCUMENTS,
    DOCUMENTS_EXCLUDED_FROM_PDF
} = require("../constants/documents");
const {
    OPERATOR_DOCUMENT_LABELS,
    ALL_OPERATOR_DOCUMENTS
} = require("../constants/operatorDocuments");

// A4 in PDF points
const A4 = [595.28, 841.89];
const MARGIN = 40;

const INK = rgb(0.13, 0.13, 0.15);
const MUTED = rgb(0.45, 0.45, 0.5);
const RULE = rgb(0.85, 0.85, 0.88);

// The summary sheet uses DD.MM.YYYY, so the pack matches it
const formatDate = (value) => {
    if (!value) return "—";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "—";
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    return `${dd}.${mm}.${d.getUTCFullYear()}`;
};

const findDoc = (docs, type) => docs.find((d) => d.document_type === type) || null;
const expiryOf = (docs, type) => formatDate(findDoc(docs, type)?.expires_at);

// Builds the driver's document pack.
//
//   driver    the users row
//   documents that driver's current documents
//   vehicles  their vehicles, each with a `documents` array
//   options   { showStatus } — the operator's copy shows review status,
//             the driver's copy does not
const buildDriverDocumentPdf = async (driver, documents, vehicles = [], options = {}) => {
    // showStatus  — the reviewer's copy shows each document's review status
    // showContact — the driver's phone and email
    //
    // These are two separate switches on purpose. The operator's copy and the
    // admin's copy both show review status, but only the admin's shows the
    // contact details — so one flag could not describe both.
    //
    // showContact defaults to true because the driver's own copy is the one
    // built with no options at all, and their own number obviously belongs on
    // it. The operator's copy has to ask for it to be hidden.
    const { showStatus = false, showContact = true } = options;

    // Selfies stay out of the pack. They exist so an operator can match the
    // face against the identity documents inside the app — they are not part
    // of a document pack anyone would send on.
    const included = documents.filter(
        (d) => !DOCUMENTS_EXCLUDED_FROM_PDF.includes(d.document_type)
    );

    // Show them in onboarding order, not alphabetically — "back" before
    // "front" makes no sense to whoever is reviewing the pack.
    const ordered = [...included].sort((a, b) => {
        const ai = ALL_DRIVER_DOCUMENTS.indexOf(a.document_type);
        const bi = ALL_DRIVER_DOCUMENTS.indexOf(b.document_type);
        return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });

    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

    pdf.setTitle(`MoveApp — ${driver.first_name} ${driver.last_name}`);
    pdf.setProducer("MoveApp");
    pdf.setCreationDate(new Date());

    // The first vehicle is the one the summary sheet describes
    const vehicle = vehicles[0] || null;
    const vehicleDocs = vehicle?.documents || [];

    // =========================================================================
    // Cover page
    // =========================================================================
    const cover = pdf.addPage(A4);
    const { width, height } = cover.getSize();

    // ---- Passport photo, top right -----------------------------------------
    const photoDoc = findDoc(ordered, "passport_photo");
    const PHOTO_W = 130;
    const PHOTO_H = 160;

    if (photoDoc?.storage_key && photoDoc.file_format !== "application/pdf") {
        try {
            const buf = await storage.readBuffer(photoDoc.storage_key);
            const img = photoDoc.file_format === "image/png"
                ? await pdf.embedPng(buf)
                : await pdf.embedJpg(buf);

            // Fit INSIDE the box. Filling it would look tidier for a real
            // passport photo, but pdf-lib cannot clip, so a wide image would
            // spill across the page — better to letterbox than to overflow.
            const scale = Math.min(PHOTO_W / img.width, PHOTO_H / img.height);
            const w = img.width * scale;
            const h = img.height * scale;

            cover.drawImage(img, {
                x: width - MARGIN - PHOTO_W + (PHOTO_W - w) / 2,
                y: height - MARGIN - PHOTO_H + (PHOTO_H - h) / 2,
                width: w,
                height: h
            });

            cover.drawRectangle({
                x: width - MARGIN - PHOTO_W,
                y: height - MARGIN - PHOTO_H,
                width: PHOTO_W,
                height: PHOTO_H,
                borderColor: RULE,
                borderWidth: 1
            });
        } catch (err) {
            console.error("Could not embed the passport photo:", err.message);
        }
    }

    let y = height - MARGIN - 18;

    cover.drawText("MoveApp", { x: MARGIN, y, size: 20, font: bold, color: INK });
    y -= 16;
    cover.drawText("Driver document pack", { x: MARGIN, y, size: 10, font, color: MUTED });

    // Room for the photo on the right
    const LABEL_X = MARGIN;
    const VALUE_X = MARGIN + 135;
    const TEXT_WIDTH = width - MARGIN - PHOTO_W - 20 - VALUE_X;

    const row = (label, value, opts = {}) => {
        const size = opts.size || 10;
        cover.drawText(label, { x: LABEL_X, y, size: 9, font: bold, color: MUTED });
        cover.drawText(String(value ?? "—"), { x: VALUE_X, y, size, font, color: INK });
        y -= 19;
    };

    const heading = (text) => {
        y -= 10;
        cover.drawText(text, { x: MARGIN, y, size: 10, font: bold, color: INK });
        y -= 6;
        cover.drawLine({
            start: { x: MARGIN, y }, end: { x: width - MARGIN, y },
            thickness: 1, color: RULE
        });
        y -= 16;
    };

    // Long addresses wrap rather than running under the photo
    const wrap = (text, maxWidth, size) => {
        const words = String(text).split(/\s+/);
        const lines = [];
        let line = "";
        for (const word of words) {
            const next = line ? `${line} ${word}` : word;
            if (font.widthOfTextAtSize(next, size) > maxWidth && line) {
                lines.push(line);
                line = word;
            } else {
                line = next;
            }
        }
        if (line) lines.push(line);
        return lines;
    };

    // ---- Driver -------------------------------------------------------------
    y -= 28;

    const fullName = [driver.title, driver.first_name, driver.middle_name, driver.last_name]
        .filter(Boolean).join(" ");

    row("Name", fullName);
    row("DOB", formatDate(driver.date_of_birth));

    // The operator often types the postcode as part of the address, so only
    // append it when it is not already in there
    const normalise = (s) => String(s || "").toUpperCase().replace(/\s/g, "");
    const postcodeAlreadyInAddress =
        driver.address && driver.postcode &&
        normalise(driver.address).includes(normalise(driver.postcode));

    const addressText = [
        driver.address,
        postcodeAlreadyInAddress ? null : driver.postcode
    ].filter(Boolean).join(", ") || "—";

    const addressLines = wrap(addressText, TEXT_WIDTH, 10);
    cover.drawText("Address", { x: LABEL_X, y, size: 9, font: bold, color: MUTED });
    addressLines.forEach((line, i) => {
        cover.drawText(line, { x: VALUE_X, y: y - i * 13, size: 10, font, color: INK });
    });
    y -= 19 + (addressLines.length - 1) * 13;

    // On the operator's copy these two lines are dropped entirely rather than
    // printed as "—". A dash invites someone to ask why the number is missing;
    // no line at all reads as a pack that was never meant to carry one.
    if (showContact) {
        row("Contact No", driver.phone);
        row("Email", driver.email);
    }

    row("NI Number", driver.ni_number);

    if (showStatus) row("Account Status", driver.status);

    // ---- Vehicle ------------------------------------------------------------
    heading("Vehicle");

    if (vehicle) {
        row("Vehicle Reg No", vehicle.registration_number);
        row("Vehicle Type", [vehicle.make, vehicle.model].filter(Boolean).join(" "));
        row("Vehicle Class", vehicle.vehicle_class);
        row("Year", vehicle.year);
        row("Colour", vehicle.color);
        row("Passenger Seats", vehicle.seats);

        const bags = [
            vehicle.luggage_large != null ? `${vehicle.luggage_large} large` : null,
            vehicle.luggage_small != null ? `${vehicle.luggage_small} small` : null
        ].filter(Boolean).join(", ");
        row("Luggage", bags || "—");

        row("Log Book", findDoc(vehicleDocs, "v5_logbook") ? "Yes" : "No");
    } else {
        row("Vehicle", "No vehicle added yet");
    }

    // ---- Expiry dates -------------------------------------------------------
    heading("Expiry dates");

    row("Driving Licence", expiryOf(ordered, "driving_licence_front"));
    row("PCO Card", expiryOf(ordered, "pco_licence_front"));
    row("Private Hire Paper Part", expiryOf(ordered, "private_hire_paper_part"));

    y -= 6;

    row("Vehicle PCO", expiryOf(vehicleDocs, "pco_vehicle_paper"));
    row("Licence Number", vehicle?.pco_licence_number);

    y -= 6;

    row("Car Insurance", expiryOf(vehicleDocs, "car_insurance"));
    row("MOT Licence", expiryOf(vehicleDocs, "mot_licence"));
    row("MOT Road Tax", expiryOf(vehicleDocs, "mot_road_tax"));

    // ---- Licence numbers ----------------------------------------------------
    heading("Licence numbers");
    row("Driving Licence No", driver.driving_licence_number);
    row("PCO Licence No", driver.pco_licence_number);

    // ---- Review status (operator's copy only) -------------------------------
    if (showStatus) {
        heading("Review status");

        for (const doc of ordered) {
            if (y < MARGIN + 30) break;
            const label = DOCUMENT_LABELS[doc.document_type] || doc.document_type;
            cover.drawText(label, { x: MARGIN, y, size: 9, font, color: INK });
            cover.drawText(doc.status, {
                x: width - MARGIN - 90, y, size: 8, font, color: MUTED
            });
            y -= 14;
        }
    }

    cover.drawText(`Generated ${formatDate(new Date())}`, {
        x: MARGIN, y: MARGIN - 12, size: 8, font, color: MUTED
    });

    // =========================================================================
    // A page per document
    // =========================================================================
    const addDocumentPages = async (docs, prefix) => {
        for (const doc of docs) {
            const base = DOCUMENT_LABELS[doc.document_type] || doc.document_type;
            const label = prefix ? `${prefix} — ${base}` : base;

            const caption = doc.expires_at
                ? `${label}   ·   expires ${formatDate(doc.expires_at)}`
                : label;

            let buffer;
            try {
                buffer = await storage.readBuffer(doc.storage_key);
            } catch (err) {
                addMissingPage(pdf, font, bold, label, "File could not be read");
                continue;
            }

            try {
                if (doc.file_format === "application/pdf") {
                    const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
                    const copied = await pdf.copyPages(src, src.getPageIndices());
                    copied.forEach((p) => pdf.addPage(p));
                } else {
                    const image = doc.file_format === "image/png"
                        ? await pdf.embedPng(buffer)
                        : await pdf.embedJpg(buffer);

                    const page = pdf.addPage(A4);
                    const pw = page.getWidth() - MARGIN * 2;
                    const ph = page.getHeight() - MARGIN * 2 - 30;

                    // Fit inside the box without distorting, and never enlarge
                    const scale = Math.min(pw / image.width, ph / image.height, 1);
                    const w = image.width * scale;
                    const h = image.height * scale;

                    page.drawText(caption, {
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
    };

    await addDocumentPages(ordered, null);

    for (const v of vehicles) {
        await addDocumentPages(v.documents || [], `Vehicle ${v.registration_number}`);
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

// Appends one page per document.
//
// buildDriverDocumentPdf has its own copy of this logic nested inside it. That
// duplication is deliberate: the driver pack is tested and in use, and pulling
// its inner function out would mean editing it to add a feature it does not
// need. This version takes its labels as an argument so it can serve operator
// documents and council licences without knowing anything about either.
const appendDocumentPages = async (pdf, font, bold, docs, labels, prefix) => {
    for (const doc of docs) {
        const base = labels[doc.document_type] || doc.label || doc.document_type;
        const label = prefix ? `${prefix} — ${base}` : base;

        const caption = doc.expires_at
            ? `${label}   ·   expires ${formatDate(doc.expires_at)}`
            : label;

        let buffer;
        try {
            buffer = await storage.readBuffer(doc.storage_key);
        } catch (err) {
            addMissingPage(pdf, font, bold, label, "File could not be read");
            continue;
        }

        try {
            if (doc.file_format === "application/pdf") {
                const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
                const copied = await pdf.copyPages(src, src.getPageIndices());
                copied.forEach((p) => pdf.addPage(p));
            } else {
                const image = doc.file_format === "image/png"
                    ? await pdf.embedPng(buffer)
                    : await pdf.embedJpg(buffer);

                const page = pdf.addPage(A4);
                const pw = page.getWidth() - MARGIN * 2;
                const ph = page.getHeight() - MARGIN * 2 - 30;

                const scale = Math.min(pw / image.width, ph / image.height, 1);
                const w = image.width * scale;
                const h = image.height * scale;

                page.drawText(caption, {
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
};

// Builds the operator's document pack — the same idea as the driver's, one
// level up: the operator is to the admin what the driver is to the operator.
//
//   operator  the users row (role = 'operator')
//   documents that operator's current business/identity documents
//   councils  their council licence rows
//   options   { showStatus } — the admin's copy shows review status,
//             the operator's own copy does not
const buildOperatorDocumentPdf = async (operator, documents, councils = [], options = {}) => {
    const { showStatus = false } = options;

    // Onboarding order, so the pack reads the way the screen is laid out
    const ordered = [...documents].sort((a, b) => {
        const ai = ALL_OPERATOR_DOCUMENTS.indexOf(a.document_type);
        const bi = ALL_OPERATOR_DOCUMENTS.indexOf(b.document_type);
        return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });

    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

    const displayName = `${operator.first_name} ${operator.last_name}`;

    pdf.setTitle(`MoveApp — ${displayName}`);
    pdf.setProducer("MoveApp");
    pdf.setCreationDate(new Date());

    // =========================================================================
    // Cover page
    // =========================================================================
    const cover = pdf.addPage(A4);
    const { width, height } = cover.getSize();

    // ---- Photograph, top right ----------------------------------------------
    // Same box and same placement as the driver's pack, so the two documents
    // look like they came from the same company.
    //
    // The photo is optional, so `hasPhoto` decides how much width the text
    // beside it may use. Reserving the space unconditionally would leave every
    // photo-less pack with a strange narrow column and an empty corner.
    const photoDoc = ordered.find((d) => d.document_type === "operator_photo");
    const PHOTO_W = 130;
    const PHOTO_H = 160;
    let hasPhoto = false;

    if (photoDoc?.storage_key && photoDoc.file_format !== "application/pdf") {
        try {
            const buf = await storage.readBuffer(photoDoc.storage_key);
            const img = photoDoc.file_format === "image/png"
                ? await pdf.embedPng(buf)
                : await pdf.embedJpg(buf);

            // Fit inside the box rather than filling it — pdf-lib cannot clip,
            // so a wide photo would spill across the page.
            const scale = Math.min(PHOTO_W / img.width, PHOTO_H / img.height);
            const w = img.width * scale;
            const h = img.height * scale;

            cover.drawImage(img, {
                x: width - MARGIN - PHOTO_W + (PHOTO_W - w) / 2,
                y: height - MARGIN - PHOTO_H + (PHOTO_H - h) / 2,
                width: w,
                height: h
            });

            cover.drawRectangle({
                x: width - MARGIN - PHOTO_W,
                y: height - MARGIN - PHOTO_H,
                width: PHOTO_W,
                height: PHOTO_H,
                borderColor: RULE,
                borderWidth: 1
            });

            hasPhoto = true;
        } catch (err) {
            // A pack without a photo is still a usable pack.
            console.error("Could not embed the operator photo:", err.message);
        }
    }

    let y = height - MARGIN - 18;

    cover.drawText("MoveApp", { x: MARGIN, y, size: 20, font: bold, color: INK });
    y -= 16;
    cover.drawText("Operator document pack", { x: MARGIN, y, size: 10, font, color: MUTED });

    const LABEL_X = MARGIN;
    const VALUE_X = MARGIN + 155;
    const TEXT_WIDTH = hasPhoto
        ? width - MARGIN - PHOTO_W - 20 - VALUE_X
        : width - MARGIN - VALUE_X;

    const row = (label, value) => {
        cover.drawText(label, { x: LABEL_X, y, size: 9, font: bold, color: MUTED });
        cover.drawText(String(value ?? "—"), { x: VALUE_X, y, size: 10, font, color: INK });
        y -= 19;
    };

    const heading = (text) => {
        y -= 10;
        cover.drawText(text, { x: MARGIN, y, size: 10, font: bold, color: INK });
        y -= 6;
        cover.drawLine({
            start: { x: MARGIN, y }, end: { x: width - MARGIN, y },
            thickness: 1, color: RULE
        });
        y -= 16;
    };

    const wrap = (text, maxWidth, size) => {
        const words = String(text).split(/\s+/);
        const lines = [];
        let line = "";
        for (const word of words) {
            const next = line ? `${line} ${word}` : word;
            if (font.widthOfTextAtSize(next, size) > maxWidth && line) {
                lines.push(line);
                line = word;
            } else {
                line = next;
            }
        }
        if (line) lines.push(line);
        return lines;
    };

    // ---- Operator -----------------------------------------------------------
    y -= 28;

    // No "Company" line. MoveApp is Eurocars London — printing the company on
    // an Eurocars document said nothing, and an outside driver has no company
    // to print.
    row("Name", [operator.title, operator.first_name, operator.middle_name,
    operator.last_name].filter(Boolean).join(" "));

    // The admin checks this against the passport and the driving licence
    // further down the pack, so it belongs on the cover beside the name.
    row("DOB", formatDate(operator.date_of_birth));

    // Same de-duplication as the driver pack — operators type the postcode into
    // the address line as often as drivers do
    const normalise = (s) => String(s || "").toUpperCase().replace(/\s/g, "");
    const postcodeAlreadyInAddress =
        operator.address && operator.postcode &&
        normalise(operator.address).includes(normalise(operator.postcode));

    const addressText = [
        operator.address,
        postcodeAlreadyInAddress ? null : operator.postcode
    ].filter(Boolean).join(", ") || "—";

    const addressLines = wrap(addressText, TEXT_WIDTH, 10);
    cover.drawText("Address", { x: LABEL_X, y, size: 9, font: bold, color: MUTED });
    addressLines.forEach((line, i) => {
        cover.drawText(line, { x: VALUE_X, y: y - i * 13, size: 10, font, color: INK });
    });
    y -= 19 + (addressLines.length - 1) * 13;

    row("Contact No", operator.phone);
    row("Email", operator.email);

    if (showStatus) row("Account Status", operator.status);

    // ---- Expiry dates -------------------------------------------------------
    heading("Expiry dates");

    const expiryOfOperatorDoc = (type) =>
        formatDate(ordered.find((d) => d.document_type === type)?.expires_at);

    row("Operator Licence", expiryOfOperatorDoc("operator_licence"));
    row("Public Liability Ins.", expiryOfOperatorDoc("public_liability_insurance"));
    row("Employer's Liability Ins.", expiryOfOperatorDoc("employers_liability_insurance"));
    row("Passport", expiryOfOperatorDoc("operator_passport"));
    row("Driving Licence", expiryOfOperatorDoc("operator_driving_licence"));

    // ---- Council licences ---------------------------------------------------
    heading("Council licences");

    if (councils.length === 0) {
        row("Councils", "None added yet");
    } else {
        for (const c of councils) {
            if (y < MARGIN + 40) break;
            row(c.council_name, `${c.licence_number}   ·   expires ${formatDate(c.expires_at)}`);
        }
    }

    // ---- Review status (admin's copy only) ----------------------------------
    if (showStatus) {
        heading("Review status");

        for (const doc of ordered) {
            if (y < MARGIN + 30) break;
            const label = OPERATOR_DOCUMENT_LABELS[doc.document_type] || doc.document_type;
            cover.drawText(label, { x: MARGIN, y, size: 9, font, color: INK });
            cover.drawText(doc.status, {
                x: width - MARGIN - 90, y, size: 8, font, color: MUTED
            });
            y -= 14;
        }
    }

    cover.drawText(`Generated ${formatDate(new Date())}`, {
        x: MARGIN, y: MARGIN - 12, size: 8, font, color: MUTED
    });

    // =========================================================================
    // A page per document, then a page per council licence
    // =========================================================================
    await appendDocumentPages(pdf, font, bold, ordered, OPERATOR_DOCUMENT_LABELS, null);

    // Council rows have no document_type, so they carry a `label` instead —
    // appendDocumentPages falls back to it.
    const councilPages = councils.map((c) => ({
        ...c,
        label: `${c.council_name} — ${c.licence_number}`
    }));

    await appendDocumentPages(pdf, font, bold, councilPages, {}, "Council licence");

    return Buffer.from(await pdf.save());
};

module.exports = { buildDriverDocumentPdf, buildOperatorDocumentPdf };