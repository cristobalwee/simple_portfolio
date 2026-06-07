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

// Turn a standalone markdown image into a <figure>, using its alt text as a
// <figcaption> rendered underneath.
function rehypeImageFigures() {
  return (tree) => {
    const visit = (node) => {
      if (!node.children) return;
      node.children = node.children.map((child) => {
        if (
          child.type === 'element' &&
          child.tagName === 'p' &&
          child.children.length === 1 &&
          child.children[0].type === 'element' &&
          child.children[0].tagName === 'img'
        ) {
          const img = child.children[0];
          const alt =
            typeof img.properties?.alt === 'string' ? img.properties.alt : '';
          const figureChildren = [img];
          if (alt) {
            figureChildren.push({
              type: 'element',
              tagName: 'figcaption',
              properties: {},
              children: [{ type: 'text', value: alt }],
            });
          }
          return {
            type: 'element',
            tagName: 'figure',
            properties: {},
            children: figureChildren,
          };
        }
        return child;
      });
      node.children.forEach(visit);
    };
    visit(tree);
  };
}

export default defineConfig({
  site: 'https://cristobalgrana.me',
  output: 'static',
  integrations: [react()],
  markdown: {
    rehypePlugins: [rehypeExternalLinksNewTab, rehypeImageFigures],
  },
});
