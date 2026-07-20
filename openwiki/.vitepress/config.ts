import { defineConfig } from "vitepress";

const repositoryName = process.env.GITHUB_REPOSITORY?.split("/")[1];
const base = process.env.GITHUB_ACTIONS === "true" && repositoryName ? `/${repositoryName}/` : "/";

export default defineConfig({
  title: "Agent Identities",
  description: "Documentation for the Paperclip Agent Identities plugin",
  base,
  srcExclude: [".last-update.json"],
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
    logo: `${base}logo.svg`,
    search: {
      provider: "local",
    },
    nav: [
      { text: "Guide", link: "/quickstart" },
      { text: "GitHub", link: "https://github.com/ambitresearch/paperclip-agent-identities" },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Overview", link: "/" },
          { text: "Quickstart", link: "/quickstart" },
          { text: "Set Up Agent Identities", link: "/guides/agent-identities-setup" },
        ],
      },
      {
        text: "Architecture",
        items: [
          { text: "Plugin Runtime", link: "/architecture/plugin-runtime" },
        ],
      },
      {
        text: "Domain",
        items: [
          { text: "Agent Identities", link: "/domain/agent-identities" },
          { text: "Slack Provisioning Decision Record", link: "/domain/slack-provisioning-decision" },
        ],
      },
      {
        text: "Tools",
        items: [
          { text: "GitHub Contribution Tools", link: "/tools/github-contribution-tools" },
        ],
      },
      {
        text: "Operations",
        items: [
          { text: "Testing and Release", link: "/operations/testing-and-release" },
        ],
      },
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/ambitresearch/paperclip-agent-identities" },
    ],
    footer: {
      message: "Generated from OpenWiki Markdown and published with VitePress.",
      copyright: "Released under the MIT License.",
    },
  },
});
