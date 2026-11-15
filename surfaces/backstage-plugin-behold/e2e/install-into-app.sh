#!/usr/bin/env bash
# Puts this plugin into a scaffolded Backstage app and wires the Infrastructure
# tab, so the app runs the plugin as an installed workspace package.
#   e2e/install-into-app.sh <app-dir> new|legacy
# <app-dir> comes from `npx @backstage/create-app@latest` (add --legacy for the
# legacy frontend system). Nothing is removed; re-running refreshes the copy.
set -euo pipefail
APP=$(cd "${1:?usage: install-into-app.sh <app-dir> new|legacy}" && pwd)
MODE=${2:?new or legacy}
HERE=$(cd "$(dirname "$0")/.." && pwd)

mkdir -p "$APP/plugins/behold"
rsync -a --exclude node_modules --exclude dist --exclude dist-types --exclude e2e --exclude package-lock.json --exclude .npmrc "$HERE/" "$APP/plugins/behold/"
cd "$APP"
# The app brings its own test and lint tooling, so the copy drops the devDependencies.
node -e 'const f="plugins/behold/package.json",fs=require("fs"),p=JSON.parse(fs.readFileSync(f));delete p.devDependencies;fs.writeFileSync(f,JSON.stringify(p,null,2)+"\n")' --
cp "$HERE/fixtures/catalog-info.yaml" examples/behold-components.yaml

node - "$MODE" <<'JS'
const fs = require("fs");
const mode = process.argv[2];
const pkgPath = "packages/app/package.json";
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
pkg.dependencies["@intentius/backstage-plugin-behold"] = "workspace:^";
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

let cfg = fs.readFileSync("app-config.yaml", "utf8");
if (!cfg.includes("\nbehold:")) {
  cfg += `
behold:
  exportUrl: http://localhost:4801/
`;
}
if (!cfg.includes("behold-components.yaml")) {
  cfg = cfg.replace(/(catalog:[\s\S]*?locations:\n)/, `$1    - type: file\n      target: ../../examples/behold-components.yaml\n`);
}
fs.writeFileSync("app-config.yaml", cfg);

if (mode === "new") {
  const f = "packages/app/src/App.tsx";
  let s = fs.readFileSync(f, "utf8");
  if (!s.includes("backstage-plugin-behold")) {
    s = s.replace("import { navModule }", "import beholdPlugin from '@intentius/backstage-plugin-behold/alpha';\nimport { navModule }");
    s = s.replace("features: [catalogPlugin,", "features: [catalogPlugin, beholdPlugin,");
    fs.writeFileSync(f, s);
  }
} else {
  const f = "packages/app/src/components/catalog/EntityPage.tsx";
  let s = fs.readFileSync(f, "utf8");
  if (!s.includes("backstage-plugin-behold")) {
    s = "import { EntityInfrastructureContent, isBeholdAvailable } from '@intentius/backstage-plugin-behold';\n" + s;
    // After the service entity's Overview route.
    s = s.replace(
      /(const serviceEntityPage = \(\s*<EntityLayout>[\s\S]*?<\/EntityLayout.Route>)/,
      `$1\n\n    <EntityLayout.Route path="/infrastructure" title="Infrastructure" if={isBeholdAvailable}>\n      <EntityInfrastructureContent />\n    </EntityLayout.Route>`,
    );
    fs.writeFileSync(f, s);
  }
}
JS
yarn install 2>&1 | tail -3
