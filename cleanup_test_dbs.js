// ===============================
// TEST DATABASE CLEANUP
// ===============================
// Every e2e suite creates its own throwaway database named
// `fm_<suite>_e2e_<pid>` and drops it on a clean exit. A suite that crashes, is
// interrupted, or exits through an assertion path leaves that database behind
// with ~24 collections in it.
//
// That matters here: this deployment enforces a CLUSTER-WIDE cap of 500
// collections (observed: "cannot create a new collection -- already using 502
// collections of 500"), not the usual per-database namespace limit. Roughly
// twenty orphaned test databases is enough to fill the whole cluster's budget,
// and then every suite that creates a collection fails at setup - which looks
// like a product bug but is pure test residue.
//
// SAFETY: this script can only ever drop a database whose name matches
//   ^fm_[a-z0-9_]+_e2e_\d+$   or   ^fm_part17_smoke_\d+$
// Production (`freshmart`), `admin`, `local`, `sample_mflix` and anything else
// fail the pattern and are reported as KEPT, never touched. Dry-run by default.
//
//   node cleanup_test_dbs.js           # list what would go
//   node cleanup_test_dbs.js --drop    # actually drop the listed test databases
// ===============================

const fs = require("fs");
const path = require("path");

const REPO = __dirname;
const envFile = fs.readFileSync(path.join(REPO, ".env"), "utf8");
const URI = (envFile.match(/^MONGODB_URI=(.+)$/m) || [])[1].trim();
const { MongoClient } = require(path.join(REPO, "node_modules/mongodb"));

const TEST_DB_PATTERNS = [/^fm_[a-z0-9_]+_e2e_\d+$/, /^fm_part17_smoke_\d+$/];
const isTestDb = (name) => TEST_DB_PATTERNS.some((re) => re.test(name));

(async () => {
    const drop = process.argv.includes("--drop");
    const client = await MongoClient.connect(URI);
    const admin = client.db().admin();
    const dbs = await admin.listDatabases();
    const names = dbs.databases.map((d) => d.name).sort();

    const doomed = [];
    const kept = [];
    for (const name of names) {
        if (!isTestDb(name)) { kept.push(name); continue; }
        const cols = await client.db(name).listCollections().toArray();
        doomed.push({ name, collections: cols.length });
    }

    console.log("databases on cluster: " + names.length);
    console.log("\nTEST databases eligible for removal (" + doomed.length + "):");
    for (const d of doomed) console.log("  " + d.collections + " collections  " + d.name);
    console.log("\nKEPT (never touched) (" + kept.length + "): " + kept.join(", "));

    if (!drop) {
        console.log("\nDRY RUN - nothing was removed. Re-run with --drop to clean up.");
        await client.close();
        return;
    }

    // Final guard immediately before the destructive step: re-verify the
    // allowlist and hard-refuse if the production database somehow matched.
    for (const d of doomed) {
        if (!isTestDb(d.name) || d.name === "freshmart") {
            console.error("REFUSING to drop " + d.name);
            await client.close();
            process.exit(1);
        }
    }

    let removedCollections = 0;
    for (const d of doomed) {
        await client.db(d.name).dropDatabase();
        removedCollections += d.collections;
        console.log("dropped " + d.name + " (" + d.collections + " collections)");
    }
    const after = await admin.listDatabases();
    console.log("\ndropped " + doomed.length + " test databases (" + removedCollections + " collections); cluster now has " + after.databases.length + " databases");
    await client.close();
})().catch((e) => {
    console.error(e.message);
    process.exit(1);
});