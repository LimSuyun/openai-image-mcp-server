#!/usr/bin/env node
/**
 * MCP Server for OpenAI GPT Image Generation.
 *
 * Provides tools to generate, edit, and create variations of images
 * using OpenAI's image models: DALL-E 2, DALL-E 3, and gpt-image-1.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import OpenAI, { toFile } from "openai";
import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHARACTER_LIMIT = 25000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ImageMeta {
  index: number;
  url?: string;
  saved_path?: string;
  revised_prompt?: string;
}

type McpContentItem =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

// ---------------------------------------------------------------------------
// OpenAI client (lazy-initialised so startup validation happens at call time)
// ---------------------------------------------------------------------------

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY environment variable is not set. " +
          "Export it before starting the server: export OPENAI_API_KEY=sk-..."
      );
    }
    _client = new OpenAI({ apiKey });
  }
  return _client;
}

// ---------------------------------------------------------------------------
// Shared error handler
// ---------------------------------------------------------------------------

function handleOpenAIError(error: unknown): string {
  if (error instanceof OpenAI.APIError) {
    switch (error.status) {
      case 400:
        return (
          `Error: Bad request — ${error.message}. ` +
          "Check your prompt for policy violations and verify parameter combinations."
        );
      case 401:
        return (
          "Error: Invalid API key. " +
          "Please check your OPENAI_API_KEY environment variable."
        );
      case 403:
        return (
          "Error: Permission denied. " +
          "Your API key may not have access to this model or feature."
        );
      case 404:
        return `Error: Resource not found — ${error.message}.`;
      case 429:
        return (
          "Error: Rate limit exceeded. " +
          "Wait before retrying. Consider using a lower resolution or fewer images (n=1)."
        );
      case 500:
        return "Error: OpenAI server error. Please try again in a few seconds.";
      default:
        return `Error: API request failed (HTTP ${error.status}): ${error.message}`;
    }
  }
  if (error instanceof Error) {
    return `Error: ${error.message}`;
  }
  return `Error: Unexpected error: ${String(error)}`;
}

// ---------------------------------------------------------------------------
// Shared helper: collect MCP content items from an OpenAI image response list
// ---------------------------------------------------------------------------

function collectImageContent(
  images: OpenAI.Image[],
  responseFormat: "url" | "b64_json",
  outputDirectory: string | undefined,
  prefix: string
): { content: McpContentItem[]; metadata: ImageMeta[] } {
  const content: McpContentItem[] = [];
  const metadata: ImageMeta[] = [];

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const meta: ImageMeta = { index: i + 1 };

    if (img.revised_prompt) {
      meta.revised_prompt = img.revised_prompt;
    }

    if (responseFormat === "b64_json" && img.b64_json) {
      content.push({
        type: "image",
        data: img.b64_json,
        mimeType: "image/png",
      });

      if (outputDirectory) {
        const filename = `${prefix}_${Date.now()}_${i + 1}.png`;
        const filepath = path.join(outputDirectory, filename);
        fs.writeFileSync(filepath, Buffer.from(img.b64_json, "base64"));
        meta.saved_path = filepath;
      }
    } else if (img.url) {
      meta.url = img.url;
      content.push({
        type: "text",
        text: `Image ${i + 1} URL (valid ~60 min): ${img.url}`,
      });
    }

    metadata.push(meta);
  }

  return { content, metadata };
}

function validateOutputDirectory(dir: string): string | null {
  if (!fs.existsSync(dir)) {
    return `Error: Output directory does not exist: ${dir}`;
  }
  if (!fs.statSync(dir).isDirectory()) {
    return `Error: Output path is not a directory: ${dir}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "openai-image-mcp-server",
  version: "1.0.0",
});

// ---------------------------------------------------------------------------
// Tool 1: gpt_image_generate
// ---------------------------------------------------------------------------

enum ResponseFormat {
  URL = "url",
  B64_JSON = "b64_json",
}

const GenerateImageSchema = z
  .object({
    prompt: z
      .string()
      .min(1, "Prompt is required")
      .max(4000, "Prompt must not exceed 4000 characters")
      .describe(
        "Text description of the desired image. Be specific for best results."
      ),
    model: z
      .enum(["dall-e-2", "dall-e-3", "gpt-image-1"])
      .default("gpt-image-1")
      .describe(
        "Image generation model. " +
          "'gpt-image-1' is the latest and most capable model. " +
          "'dall-e-3' supports style parameter and revised prompts. " +
          "'dall-e-2' supports generating up to 10 images at once."
      ),
    n: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(1)
      .describe(
        "Number of images to generate (1–10). " +
          "dall-e-3 and gpt-image-1 only support n=1."
      ),
    size: z
      .enum(["256x256", "512x512", "1024x1024", "1792x1024", "1024x1792"])
      .default("1024x1024")
      .describe(
        "Dimensions of the generated image. " +
          "256x256 and 512x512 only available for dall-e-2. " +
          "1792x1024 and 1024x1792 only available for dall-e-3."
      ),
    quality: z
      .enum(["standard", "hd", "low", "medium", "high"])
      .optional()
      .describe(
        "Image quality level. " +
          "'standard'/'hd' for dall-e-3 (hd = finer detail). " +
          "'low'/'medium'/'high' for gpt-image-1."
      ),
    style: z
      .enum(["vivid", "natural"])
      .optional()
      .describe(
        "Visual style (dall-e-3 only). " +
          "'vivid' = hyper-real and dramatic. 'natural' = realistic, less exaggerated."
      ),
    response_format: z
      .nativeEnum(ResponseFormat)
      .default(ResponseFormat.URL)
      .describe(
        "Return format. 'url' gives download links (valid ~60 min). " +
          "'b64_json' embeds image data in the response. " +
          "Note: gpt-image-1 only supports 'b64_json' — 'url' will be ignored and overridden automatically."
      ),
    output_directory: z
      .string()
      .optional()
      .describe(
        "Directory to save generated images as PNG files. " +
          "Only works when response_format='b64_json'."
      ),
  })
  .strict();

type GenerateImageInput = z.infer<typeof GenerateImageSchema>;

server.registerTool(
  "gpt_image_generate",
  {
    title: "Generate Image",
    description: `Generate one or more images from a text prompt using OpenAI's image models.

Supports DALL-E 2, DALL-E 3, and gpt-image-1. Returns images as URLs or embedded base64 data.

Args:
  - prompt (string, required): Text description. Max 4000 chars.
  - model ('dall-e-2'|'dall-e-3'|'gpt-image-1'): Model to use. Default: 'gpt-image-1'
  - n (number): Images to generate, 1-10. DALL-E 3 and gpt-image-1 only support n=1. Default: 1
  - size ('256x256'|'512x512'|'1024x1024'|'1792x1024'|'1024x1792'): Dimensions. Default: '1024x1024'
  - quality ('standard'|'hd'|'low'|'medium'|'high'): Quality level. Optional.
  - style ('vivid'|'natural'): Visual style, dall-e-3 only. Optional.
  - response_format ('url'|'b64_json'): Return format. Default: 'url'
  - output_directory (string): Directory to save PNG files (requires response_format='b64_json'). Optional.

Returns:
  - Image URLs or embedded base64 image data
  - Metadata: model used, revised prompt (dall-e-3), saved file paths

Examples:
  - "A photorealistic portrait of a tabby cat sitting on a windowsill"
  - model="dall-e-3", quality="hd", prompt="Detailed oil painting of a medieval castle"
  - size="1792x1024", prompt="Wide cinematic shot of a foggy mountain valley at sunrise"`,
    inputSchema: GenerateImageSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (params: GenerateImageInput) => {
    try {
      // gpt-image-1 does not accept response_format param; always returns b64_json
      const isGptImage1 = params.model === "gpt-image-1";
      const responseFormat = isGptImage1 ? ResponseFormat.B64_JSON : params.response_format;

      if (params.output_directory) {
        const dirError = validateOutputDirectory(params.output_directory);
        if (dirError) {
          return { isError: true, content: [{ type: "text" as const, text: dirError }] };
        }
        if (responseFormat !== ResponseFormat.B64_JSON) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text:
                  "Error: output_directory requires response_format='b64_json'. " +
                  "Set response_format='b64_json' to save files.",
              },
            ],
          };
        }
      }

      const client = getClient();

      const requestParams: OpenAI.Images.ImageGenerateParams = {
        prompt: params.prompt,
        model: params.model,
        n: params.n,
        size: params.size as OpenAI.Images.ImageGenerateParams["size"],
      };

      // gpt-image-1 does not support response_format parameter
      if (!isGptImage1) {
        requestParams.response_format =
          responseFormat as OpenAI.Images.ImageGenerateParams["response_format"];
      }

      if (params.quality) {
        requestParams.quality =
          params.quality as OpenAI.Images.ImageGenerateParams["quality"];
      }
      if (params.style && params.model === "dall-e-3") {
        requestParams.style =
          params.style as OpenAI.Images.ImageGenerateParams["style"];
      }

      const response = await client.images.generate(requestParams);
      const images = response.data ?? [];

      const { content, metadata } = collectImageContent(
        images,
        responseFormat,
        params.output_directory,
        "generated"
      );

      const summaryLines = [
        `Generated ${images.length} image(s) with ${params.model}`,
        `Prompt: "${params.prompt}"`,
      ];
      for (const m of metadata) {
        summaryLines.push(`\nImage ${m.index}:`);
        if (m.revised_prompt) summaryLines.push(`  Revised prompt: ${m.revised_prompt}`);
        if (m.url) summaryLines.push(`  URL: ${m.url}`);
        if (m.saved_path) summaryLines.push(`  Saved: ${m.saved_path}`);
      }

      const summary = summaryLines.join("\n");
      const finalContent: McpContentItem[] = [{ type: "text", text: summary }, ...content];

      // Truncate text summary if it somehow exceeds the limit
      const textItem = finalContent[0] as { type: "text"; text: string };
      if (textItem.text.length > CHARACTER_LIMIT) {
        textItem.text = textItem.text.slice(0, CHARACTER_LIMIT) + "\n[truncated]";
      }

      return { content: finalContent };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: handleOpenAIError(error) }],
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 2: gpt_image_edit
// ---------------------------------------------------------------------------

const EditImageSchema = z
  .object({
    image_path: z
      .string()
      .min(1, "image_path is required")
      .describe(
        "Absolute path to the PNG image file to edit. " +
          "Must be PNG format, square dimensions, and under 4 MB."
      ),
    prompt: z
      .string()
      .min(1, "Prompt is required")
      .max(1000, "Prompt must not exceed 1000 characters")
      .describe("Text description of the desired edit."),
    mask_path: z
      .string()
      .optional()
      .describe(
        "Absolute path to a PNG mask file. " +
          "Fully transparent (alpha=0) pixels indicate where to apply edits. " +
          "If omitted the entire image is eligible for editing."
      ),
    model: z
      .enum(["dall-e-2"])
      .default("dall-e-2")
      .describe(
        "Model for editing. Only dall-e-2 supports image editing."
      ),
    n: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(1)
      .describe("Number of edited images to produce (1–10)."),
    size: z
      .enum(["256x256", "512x512", "1024x1024"])
      .default("1024x1024")
      .describe("Output image dimensions."),
    response_format: z
      .nativeEnum(ResponseFormat)
      .default(ResponseFormat.URL)
      .describe("Return format: 'url' or 'b64_json'."),
    output_directory: z
      .string()
      .optional()
      .describe(
        "Directory to save edited images as PNG files. " +
          "Requires response_format='b64_json'."
      ),
  })
  .strict();

type EditImageInput = z.infer<typeof EditImageSchema>;

server.registerTool(
  "gpt_image_edit",
  {
    title: "Edit Image",
    description: `Edit an existing image using a text prompt and optional mask (inpainting).

Transparent areas in the mask indicate regions to edit. Without a mask, the model may edit the whole image.

Args:
  - image_path (string, required): Absolute path to PNG image (square, < 4 MB)
  - prompt (string, required): Description of the desired edit. Max 1000 chars.
  - mask_path (string): Absolute path to PNG mask. Transparent pixels = edit zone. Optional.
  - model ('dall-e-2'|'gpt-image-1'): Model to use. Default: 'gpt-image-1'
  - n (number): Number of results (1–10). Default: 1
  - size ('256x256'|'512x512'|'1024x1024'): Output size. Default: '1024x1024'
  - response_format ('url'|'b64_json'): Return format. Default: 'url'
  - output_directory (string): Directory to save PNG files (requires response_format='b64_json'). Optional.

Returns:
  - Edited image(s) as URLs or embedded base64 data

Examples:
  - Add object: image_path="/photos/room.png", prompt="Add a potted plant near the window"
  - Inpaint area: image_path="/img.png", mask_path="/mask.png", prompt="Replace with clear blue sky"
  - Remove text: image_path="/sign.png", prompt="Remove all text from the sign"`,
    inputSchema: EditImageSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (params: EditImageInput) => {
    try {
      if (!fs.existsSync(params.image_path)) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error: Image file not found: ${params.image_path}` }],
        };
      }

      if (params.mask_path && !fs.existsSync(params.mask_path)) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error: Mask file not found: ${params.mask_path}` }],
        };
      }

      if (params.output_directory) {
        const dirError = validateOutputDirectory(params.output_directory);
        if (dirError) {
          return { isError: true, content: [{ type: "text" as const, text: dirError }] };
        }
        if (params.response_format !== ResponseFormat.B64_JSON) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: "Error: output_directory requires response_format='b64_json'.",
              },
            ],
          };
        }
      }

      const client = getClient();
      const imageName = path.basename(params.image_path);

      const requestParams: OpenAI.Images.ImageEditParams = {
        image: await toFile(fs.createReadStream(params.image_path), imageName, { type: "image/png" }),
        prompt: params.prompt,
        model: params.model,
        n: params.n,
        size: params.size as OpenAI.Images.ImageEditParams["size"],
        response_format:
          params.response_format as OpenAI.Images.ImageEditParams["response_format"],
      };

      if (params.mask_path) {
        const maskName = path.basename(params.mask_path);
        requestParams.mask = await toFile(fs.createReadStream(params.mask_path), maskName, { type: "image/png" });
      }

      const response = await client.images.edit(requestParams);
      const images = response.data ?? [];

      const { content, metadata } = collectImageContent(
        images,
        params.response_format,
        params.output_directory,
        "edited"
      );

      const summaryLines = [
        `Edited ${images.length} image(s) with ${params.model}`,
        `Source: ${params.image_path}`,
        `Prompt: "${params.prompt}"`,
      ];
      for (const m of metadata) {
        summaryLines.push(`\nImage ${m.index}:`);
        if (m.url) summaryLines.push(`  URL: ${m.url}`);
        if (m.saved_path) summaryLines.push(`  Saved: ${m.saved_path}`);
      }

      const finalContent: McpContentItem[] = [
        { type: "text", text: summaryLines.join("\n") },
        ...content,
      ];

      return { content: finalContent };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: handleOpenAIError(error) }],
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 3: gpt_image_create_variation
// ---------------------------------------------------------------------------

const CreateVariationSchema = z
  .object({
    image_path: z
      .string()
      .min(1, "image_path is required")
      .describe(
        "Absolute path to the PNG image file to vary. " +
          "Must be square and under 4 MB. Only DALL-E 2 supports this operation."
      ),
    n: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(1)
      .describe("Number of variations to generate (1–10)."),
    size: z
      .enum(["256x256", "512x512", "1024x1024"])
      .default("1024x1024")
      .describe("Output dimensions."),
    response_format: z
      .nativeEnum(ResponseFormat)
      .default(ResponseFormat.URL)
      .describe("Return format: 'url' or 'b64_json'."),
    output_directory: z
      .string()
      .optional()
      .describe(
        "Directory to save variation images as PNG files. " +
          "Requires response_format='b64_json'."
      ),
  })
  .strict();

type CreateVariationInput = z.infer<typeof CreateVariationSchema>;

server.registerTool(
  "gpt_image_create_variation",
  {
    title: "Create Image Variation",
    description: `Create one or more stylistic variations of an existing image using DALL-E 2.

Note: Only DALL-E 2 supports this operation. Input must be a square PNG under 4 MB.

Args:
  - image_path (string, required): Absolute path to source PNG (square, < 4 MB)
  - n (number): Number of variations to generate (1–10). Default: 1
  - size ('256x256'|'512x512'|'1024x1024'): Output size. Default: '1024x1024'
  - response_format ('url'|'b64_json'): Return format. Default: 'url'
  - output_directory (string): Directory to save PNG files (requires response_format='b64_json'). Optional.

Returns:
  - Variation image(s) as URLs or embedded base64 data

Examples:
  - 3 variations: image_path="/art/original.png", n=3
  - Save to disk: image_path="/img.png", n=2, response_format="b64_json", output_directory="/output"`,
    inputSchema: CreateVariationSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (params: CreateVariationInput) => {
    try {
      if (!fs.existsSync(params.image_path)) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error: Image file not found: ${params.image_path}` }],
        };
      }

      if (params.output_directory) {
        const dirError = validateOutputDirectory(params.output_directory);
        if (dirError) {
          return { isError: true, content: [{ type: "text" as const, text: dirError }] };
        }
        if (params.response_format !== ResponseFormat.B64_JSON) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: "Error: output_directory requires response_format='b64_json'.",
              },
            ],
          };
        }
      }

      const client = getClient();

      const response = await client.images.createVariation({
        image: fs.createReadStream(params.image_path),
        n: params.n,
        size: params.size as OpenAI.Images.ImageCreateVariationParams["size"],
        response_format:
          params.response_format as OpenAI.Images.ImageCreateVariationParams["response_format"],
      });

      const images = response.data ?? [];

      const { content, metadata } = collectImageContent(
        images,
        params.response_format,
        params.output_directory,
        "variation"
      );

      const summaryLines = [
        `Created ${images.length} variation(s) with dall-e-2`,
        `Source: ${params.image_path}`,
      ];
      for (const m of metadata) {
        summaryLines.push(`\nVariation ${m.index}:`);
        if (m.url) summaryLines.push(`  URL: ${m.url}`);
        if (m.saved_path) summaryLines.push(`  Saved: ${m.saved_path}`);
      }

      const finalContent: McpContentItem[] = [
        { type: "text", text: summaryLines.join("\n") },
        ...content,
      ];

      return { content: finalContent };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: handleOpenAIError(error) }],
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.error(
      "ERROR: OPENAI_API_KEY environment variable is required.\n" +
        "Set it before starting: export OPENAI_API_KEY=sk-..."
    );
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("openai-image-mcp-server running on stdio");
}

main().catch((error: unknown) => {
  console.error("Fatal server error:", error);
  process.exit(1);
});
