// Move the files already on disk into Cloudinary.
//
//   node scripts/migrateUploadsToCloudinary.js --dry-run
//   node scripts/migrateUploadsToCloudinary.js
//
// Run the dry run first. It reports what it would move and touches nothing.
//
// Why this exists: every document uploaded before Cloudinary lives in
// ./uploads on one laptop. The database rows still point at those keys, so on
// Vercel they resolve to files that are not there. Rather than making everyone
// re-upload, the files are pushed up and the rows repointed.
//
// Safe to run more than once — rows already carrying a cloud key are skipped,
// so a run that dies halfway can simply be run again.
//
// The original files are NOT deleted. They are the only copy until this has
// been proven, and deleting them is a decision for a person, not a script.

require("dotenv").config();

const fsp = require("fs/promises");
const path = require("path");
const pool = require("../config/db");
const storage = require("../services/storageService");

const DRY_RUN = process.argv.includes("--dry-run");
const UPLOAD_ROOT = path.join(process.cwd(), "uploads");

// Every table that holds a storage key. Adding a new kind of document means
// adding a line here — which is easy to forget, so the count at the end is
// worth checking against what you expected.
const TABLES = [
    { table: "driver_documents", label: "driver documents" },
    { table: "vehicle_documents", label: "vehicle documents" },
    { table: "operator_documents", label: "operator documents" },
    { table: "operator_councils", label: "council licences" }
];

const extensionOf = (key) => {
    const ext = path.extname(key).replace(".", "").toLowerCase();
    return ext || "bin";
};

const migrateTable = async ({ table, label }) => {
    const summary = { table: label, moved: 0, skipped: 0, missing: 0, failed: 0 };

    // Only rows still on a local key. A cloud key means this row is done.
    let rows;
    try {
        const result = await pool.query(
            `SELECT id, storage_key FROM ${table}
             WHERE storage_key IS NOT NULL AND storage_key NOT LIKE 'cld:%'
             ORDER BY id`
        );
        rows = result.rows;
    } catch (error) {
        // A table that does not exist in this database is not a failure — not
        // every deployment has every document type.
        if (error.code === "42P01") {
            console.log(`  (no ${label} table — skipping)`);
            return summary;
        }
        throw error;
    }

    for (const row of rows) {
        const fullPath = path.join(UPLOAD_ROOT, row.storage_key);

        let buffer;
        try {
            buffer = await fsp.readFile(fullPath);
        } catch {
            // The row points at a file nobody has. Left exactly as it is: the
            // row is the record that a document was uploaded, and rewriting it
            // would destroy that without putting anything in its place.
            console.log(`  MISSING  ${label} #${row.id}  ${row.storage_key}`);
            summary.missing += 1;
            continue;
        }

        if (DRY_RUN) {
            console.log(`  would move  ${label} #${row.id}  ${row.storage_key}  (${buffer.length} bytes)`);
            summary.moved += 1;
            continue;
        }

        try {
            const saved = await storage.save(buffer, extensionOf(row.storage_key));

            // The row is updated only after the upload has succeeded. If the
            // process dies here, the row still points at the local file that
            // is still there — nothing is lost, and the next run redoes it.
            await pool.query(
                `UPDATE ${table} SET storage_key = $2 WHERE id = $1`,
                [row.id, saved.key]
            );

            console.log(`  moved    ${label} #${row.id}  -> ${saved.key}`);
            summary.moved += 1;

        } catch (error) {
            console.error(`  FAILED   ${label} #${row.id}: ${error.message}`);
            summary.failed += 1;
        }
    }

    return summary;
};

(async () => {
    if (!storage.useCloudinary) {
        console.error("Cloudinary is not configured — set CLOUDINARY_CLOUD_NAME,");
        console.error("CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET in .env first.");
        process.exitCode = 1;
        await pool.end().catch(() => { });
        return;
    }

    console.log(DRY_RUN
        ? "Moving uploads to Cloudinary (DRY RUN — nothing will be changed)"
        : "Moving uploads to Cloudinary");
    console.log("");

    const summaries = [];

    try {
        for (const spec of TABLES) {
            console.log(`${spec.label}:`);
            summaries.push(await migrateTable(spec));
            console.log("");
        }

        console.log("----------------------------------------");
        let totalMoved = 0, totalMissing = 0, totalFailed = 0;

        for (const s of summaries) {
            console.log(`${s.table.padEnd(20)} moved ${s.moved}  missing ${s.missing}  failed ${s.failed}`);
            totalMoved += s.moved;
            totalMissing += s.missing;
            totalFailed += s.failed;
        }

        console.log("----------------------------------------");
        console.log(`total: ${totalMoved} moved, ${totalMissing} missing, ${totalFailed} failed`);

        if (totalMissing > 0) {
            console.log("");
            console.log("Rows marked MISSING point at files that are not on this machine.");
            console.log("They have been left alone. Those documents will need re-uploading.");
        }

        if (!DRY_RUN && totalFailed === 0 && totalMoved > 0) {
            console.log("");
            console.log("The ./uploads folder has NOT been deleted. Check a few documents");
            console.log("through the API first, then remove it by hand when you are happy.");
        }

        process.exitCode = totalFailed > 0 ? 1 : 0;

    } catch (error) {
        console.error("Migration failed:", error);
        process.exitCode = 1;

    } finally {
        await pool.end().catch(() => { });
    }
})();