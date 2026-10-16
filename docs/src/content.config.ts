import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';
import { promptText } from './prompts';

export const collections = {
	docs: defineCollection({
		loader: docsLoader(),
		schema: docsSchema({
			extend: z.object({
				// "Optional: hand this page to your coding agent": the prompt the page
				// header shows under the title, and llms.txt and llms-full.txt carry.
				// `prompt: setup` is the setup prompt from src/prompts.ts.
				// scripts/lint-prompts.mjs checks every one.
				prompt: z.string().optional().transform(promptText),
				// A page built from data rather than a Markdown file (the rooms under
				// /for/) carries its Markdown here, for "Copy page as Markdown" and
				// llms-full.txt.
				markdown: z.string().optional(),
			}),
		}),
	}),
};
