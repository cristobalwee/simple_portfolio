import { defineConfig } from 'astro/config';
import react from '@astrojs/react';

// Open external links (http/https) in a new tab; keep internal links in the same tab.
function rehypeExternalLinksNewTab() {
  return (tree) => {
    const visit = (node) => {
      if (
        node.type === 'element' &&
        node.tagName === 'a' &&
        typeof node.properties?.href === 'string' &&
        /^https?:\/\//.test(node.properties.href)
      ) {
        node.properties.target = '_blank';
        node.properties.rel = 'noreferrer';
      }
      if (node.children) node.children.forEach(visit);
    };
    visit(tree);
  };
}

export default defineConfig({
  site: 'https://cristobalgrana.me',
  output: 'static',
  integrations: [react()],
  markdown: {
    rehypePlugins: [rehypeExternalLinksNewTab],
  },
});
