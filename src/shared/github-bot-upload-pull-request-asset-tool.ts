export const githubBotUploadPullRequestAssetToolName = "github_bot_upload_pull_request_asset";

export const githubBotUploadPullRequestAssetToolMetadata = {
  displayName: "Upload Pull Request Asset (Agent Identity)",
  description:
    "Uploads a file to an artifact branch (artifacts/pr-{pullNumber}) in the repository and returns " +
    "an embeddable Markdown reference. Images are returned as inline Markdown image syntax; other files " +
    "as a Markdown link. The artifact branch is created automatically if it does not yet exist.",
  parametersSchema: {
    type: "object",
    properties: {
      repository: {
        type: "string",
        description: 'Target repository in owner/repo format (e.g. "my-org/my-repo")',
      },
      pullNumber: {
        type: "number",
        description: "The pull request number the asset belongs to",
      },
      fileName: {
        type: "string",
        description: "File name to use when storing the asset (e.g. \"screenshot.png\")",
      },
      contentBase64: {
        type: "string",
        description: "Base64-encoded file contents",
      },
      mimeType: {
        type: "string",
        description: "Optional MIME type of the file (used to decide image vs link rendering)",
      },
      commitMessage: {
        type: "string",
        description: "Optional commit message for the upload commit",
      },
    },
    required: ["repository", "pullNumber", "fileName", "contentBase64"],
  },
} as const;

export const githubBotUploadPullRequestAssetManifestTool = {
  name: githubBotUploadPullRequestAssetToolName,
  ...githubBotUploadPullRequestAssetToolMetadata,
} as const;
