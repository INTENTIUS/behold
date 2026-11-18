// The live public demo: behold following real terragucci pipelines in a
// loop, read-only, at demo.intentius.io. The home page, the rooms and
// llms.txt link it from here.
export const LIVE = 'https://demo.intentius.io/kiosk';

/** The demo's page per tool. */
export const LIVE_TOOLS = [
	{ label: 'Terraform', href: 'https://demo.intentius.io/terraform' },
	{ label: 'Terragrunt', href: 'https://demo.intentius.io/terragrunt' },
	{ label: 'CDK Terrain', href: 'https://demo.intentius.io/cdk-terrain' },
	{ label: 'choudoufu', href: 'https://demo.intentius.io/choudoufu' },
];

// The ask demo: a recording of a coding agent asking an estate questions
// through behold, answered in Cypher, served as a Cloudflare Worker
// (`just ask-demo-deploy`). It is a recording, so it is never called live.
// The home page and llms.txt link it, beside the live demo.
export const ASK_DEMO = 'https://behold-ask-demo.intentius.workers.dev/';
