#!/usr/bin/env node
// behold#1227 recording aid: a stand-in engine that prints a recorded preview for the member it runs in.
const fs = require("fs"), path = require("path");
fs.appendFileSync(path.join(__dirname, "calls.log"), JSON.stringify([path.basename(process.argv[1]), process.cwd(), ...process.argv.slice(2)]) + "\n");
const args = process.argv.slice(2);
if (args[0] !== "preview") { process.stderr.write("error: only preview is recorded here\n"); process.exit(255); }
const file = path.join(__dirname, "..", "previews", path.basename(process.cwd()) + ".json");
if (!fs.existsSync(file)) { process.stderr.write("error: no stack is selected\n"); process.exit(255); }
process.stdout.write(fs.readFileSync(file, "utf8"));
