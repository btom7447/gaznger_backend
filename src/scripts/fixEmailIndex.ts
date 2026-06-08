/**
 * One-shot fix for the legacy `email_1` unique index on the users
 * collection. The old index treated `email: null` as a collide-able
 * value, so a second user without an email failed with E11000.
 *
 * This script drops the bad index (if present) and recreates it as a
 * partial-unique that only enforces uniqueness when `email` is a
 * non-empty string. Multiple users with no email no longer collide.
 *
 * Run: npx ts-node src/scripts/fixEmailIndex.ts
 *
 * Safe to re-run — `dropIndex` skips silently if the name is missing,
 * and `createIndex` is a no-op if the same key+options already exist.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import mongoose from "mongoose";

async function run() {
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI missing — check server/.env.local");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 8000,
  });
  console.log("Connected:", mongoose.connection.host);

  const users = mongoose.connection.db!.collection("users");

  // 1. List current email-related indexes.
  const before = (await users.indexes()).filter(
    (i) => i.key && Object.prototype.hasOwnProperty.call(i.key, "email"),
  );
  console.log("\nemail indexes before:");
  console.log(JSON.stringify(before, null, 2));

  // 2. Drop the bad one if it's the plain-unique flavour.
  const bad = before.find(
    (i) =>
      i.name === "email_1" &&
      i.unique &&
      !i.partialFilterExpression &&
      !i.sparse,
  );
  if (bad) {
    console.log("\nDropping legacy email_1 (unique, non-partial)…");
    await users.dropIndex("email_1");
  } else {
    console.log("\nNo legacy email_1 index to drop.");
  }

  // 3. Create the partial-unique index.
  console.log("Creating partial-unique email_1…");
  await users.createIndex(
    { email: 1 },
    {
      name: "email_1",
      unique: true,
      partialFilterExpression: { email: { $type: "string" } },
    },
  );

  // 4. Print the result.
  const after = (await users.indexes()).filter(
    (i) => i.key && Object.prototype.hasOwnProperty.call(i.key, "email"),
  );
  console.log("\nemail indexes after:");
  console.log(JSON.stringify(after, null, 2));

  await mongoose.disconnect();
  console.log("\nDone.");
  process.exit(0);
}

run().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
