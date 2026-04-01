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
import os from "os";
import sharp from "sharp";

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

const MCP_INLINE_SIZE_LIMIT = 5 * 1024 * 1024; // 5 MB in base64 bytes (~3.75 MB raw)

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
      const saveDir = outputDirectory ?? os.tmpdir();
      const filename = `${prefix}_${Date.now()}_${i + 1}.png`;
      const filepath = path.join(saveDir, filename);
      fs.writeFileSync(filepath, Buffer.from(img.b64_json, "base64"));
      meta.saved_path = filepath;

      // Only embed inline if small enough to avoid hitting MCP's 20 MB response limit
      if (img.b64_json.length <= MCP_INLINE_SIZE_LIMIT) {
        content.push({
          type: "image",
          data: img.b64_json,
          mimeType: "image/png",
        });
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

/**
 * If the image at `filePath` exceeds `maxBytes`, resizes it iteratively
 * (reducing dimensions by 10% each pass) until it fits.
 * Returns the path to use (original if no resize needed, temp file otherwise)
 * and a log message describing what happened.
 */
async function resizeImageToFitLimit(
  filePath: string,
  maxBytes: number
): Promise<{ resolvedPath: string; resizeNote: string | null }> {
  const stats = fs.statSync(filePath);
  if (stats.size <= maxBytes) {
    return { resolvedPath: filePath, resizeNote: null };
  }

  const originalMB = (stats.size / (1024 * 1024)).toFixed(2);
  const maxMB = (maxBytes / (1024 * 1024)).toFixed(0);

  let image = sharp(filePath);
  const meta = await image.metadata();
  let width = meta.width ?? 1024;
  let height = meta.height ?? 1024;

  let tmpPath: string | null = null;
  let attempts = 0;
  const MAX_ATTEMPTS = 20;

  while (attempts < MAX_ATTEMPTS) {
    width = Math.round(width * 0.9);
    height = Math.round(height * 0.9);
    attempts++;

    const resized = await sharp(filePath)
      .resize(width, height)
      .png({ compressionLevel: 9 })
      .toBuffer();

    if (resized.length <= maxBytes) {
      tmpPath = path.join(os.tmpdir(), `mcp_resized_${Date.now()}.png`);
      fs.writeFileSync(tmpPath, resized);
      const newMB = (resized.length / (1024 * 1024)).toFixed(2);
      return {
        resolvedPath: tmpPath,
        resizeNote:
          `Note: Image was automatically resized from ${originalMB} MB to ${newMB} MB ` +
          `(${width}x${height}) to meet the ${maxMB} MB API limit.`,
      };
    }
  }

  throw new Error(
    `Unable to reduce image below ${maxMB} MB after ${MAX_ATTEMPTS} attempts. ` +
      `Please provide a smaller image.`
  );
}

/**
 * Ensures the image at `filePath` has an alpha channel (RGBA).
 * Returns the original path if already RGBA, otherwise writes a converted temp file.
 */
async function ensureRGBA(filePath: string): Promise<{ resolvedPath: string; convertNote: string | null }> {
  const meta = await sharp(filePath).metadata();
  if (meta.channels === 4 && meta.hasAlpha) {
    return { resolvedPath: filePath, convertNote: null };
  }

  const tmpPath = path.join(os.tmpdir(), `mcp_rgba_${Date.now()}.png`);
  await sharp(filePath).ensureAlpha().png().toFile(tmpPath);
  return {
    resolvedPath: tmpPath,
    convertNote: "Note: Image was automatically converted from RGB to RGBA (required by the edit API).",
  };
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
          "Must be PNG format, under 4 MB. " +
          "Oversized images are automatically resized. RGB images are auto-converted to RGBA."
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
      .describe("Model for editing. Only dall-e-2 supports image editing."),
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
  - image_path (string, required): Absolute path to PNG image (< 4 MB). Auto-resized if over limit. RGB images are auto-converted to RGBA.
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

      const { resolvedPath: resolvedImagePath, resizeNote: imageResizeNote } =
        await resizeImageToFitLimit(params.image_path, 4 * 1024 * 1024);

      if (params.mask_path && !fs.existsSync(params.mask_path)) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error: Mask file not found: ${params.mask_path}` }],
        };
      }

      let resolvedMaskPath = params.mask_path;
      let maskResizeNote: string | null = null;
      if (params.mask_path) {
        ({ resolvedPath: resolvedMaskPath, resizeNote: maskResizeNote } =
          await resizeImageToFitLimit(params.mask_path, 4 * 1024 * 1024));
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

      const { resolvedPath: rgbaImagePath, convertNote: imageConvertNote } =
        await ensureRGBA(resolvedImagePath);

      let rgbaMaskPath = resolvedMaskPath;
      let maskConvertNote: string | null = null;
      if (resolvedMaskPath) {
        ({ resolvedPath: rgbaMaskPath, convertNote: maskConvertNote } =
          await ensureRGBA(resolvedMaskPath));
      }

      const client = getClient();
      const imageName = path.basename(rgbaImagePath);

      const requestParams: OpenAI.Images.ImageEditParams = {
        image: await toFile(fs.createReadStream(rgbaImagePath), imageName, { type: "image/png" }),
        prompt: params.prompt,
        model: params.model,
        n: params.n,
        size: params.size as OpenAI.Images.ImageEditParams["size"],
        response_format:
          params.response_format as OpenAI.Images.ImageEditParams["response_format"],
      };

      if (rgbaMaskPath) {
        const maskName = path.basename(rgbaMaskPath);
        requestParams.mask = await toFile(fs.createReadStream(rgbaMaskPath), maskName, { type: "image/png" });
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
      if (imageResizeNote) summaryLines.push(imageResizeNote);
      if (maskResizeNote) summaryLines.push(maskResizeNote);
      if (imageConvertNote) summaryLines.push(imageConvertNote);
      if (maskConvertNote) summaryLines.push(maskConvertNote);
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

      const { resolvedPath: resolvedImagePath, resizeNote } =
        await resizeImageToFitLimit(params.image_path, 4 * 1024 * 1024);

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
        image: fs.createReadStream(resolvedImagePath),
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
      if (resizeNote) summaryLines.push(resizeNote);
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
