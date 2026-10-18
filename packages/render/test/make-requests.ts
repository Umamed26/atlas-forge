import { writeFileSync } from "node:fs";
import { createDefaultDocument } from "@atlas/core";
const doc = createDefaultDocument({
  name: "Aetheris",
  seed: 20261018,
  style: { labelDensity: 0.8, paperTexture: 0.62, hillshadeStrength: 0.65, coastHatching: 0.7 },
});
writeFileSync("out/req-512.json", JSON.stringify({ document: doc, size: 512 }));
writeFileSync("out/req-4096.json", JSON.stringify({ document: doc, size: 4096 }));
writeFileSync("out/req-8192.json", JSON.stringify({ document: doc, size: 8192 }));
writeFileSync("out/req-bad-size.json", JSON.stringify({ document: doc, size: 123 }));
writeFileSync("out/req-bad-doc.json", JSON.stringify({ document: { version: 2 }, size: 512 }));
console.log("wrote request fixtures");
