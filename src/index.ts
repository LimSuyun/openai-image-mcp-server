#!/usr/bin/env node
/**
 * MCP Server for OpenAI GPT Image Generation.
 *
 * Provides tools to generate, edit, and create variations of images
 * using OpenAI's gpt-image models: gpt-image-1, gpt-image-1-mini,
 * gpt-image-1.5, and gpt-image-2.
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

// Supported gpt-image model IDs (DALL-E 2/3 were retired on 2026-05-12)
const IMAGE_MODELS = [
  "gpt-image-1",
  "gpt-image-1-mini",
  "gpt-image-1.5",
  "gpt-image-2",
] as const;
type ImageModel = (typeof IMAGE_MODELS)[number];

// Model used internally by character/pose/sprite tools. These tools rely on the
// "pure white background" prompt + flood-fill post-processing rather than the API's
// `background` parameter, so gpt-image-2 (which lacks native transparent-bg support)
// is fine here.
const INTERNAL_IMAGE_MODEL: ImageModel = "gpt-image-2";

// gpt-image edit endpoint accepts up to 25 MB per image (vs. DALL-E's 4 MB).
const MAX_IMAGE_UPLOAD_BYTES = 25 * 1024 * 1024;

const IMAGE_SIZES = ["1024x1024", "1024x1536", "1536x1024", "auto"] as const;
const IMAGE_QUALITIES = ["low", "medium", "high", "auto"] as const;
const OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
const BACKGROUND_OPTIONS = ["transparent", "opaque", "auto"] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ImageMeta {
  index: number;
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
const DEFAULT_OUTPUT_DIR = path.join(process.cwd(), "openai-image-gen");

function getDefaultOutputDir(): string {
  if (!fs.existsSync(DEFAULT_OUTPUT_DIR)) {
    fs.mkdirSync(DEFAULT_OUTPUT_DIR, { recursive: true });
  }
  return DEFAULT_OUTPUT_DIR;
}

function collectImageContent(
  images: OpenAI.Image[],
  outputDirectory: string | undefined,
  prefix: string,
  outputFormat: (typeof OUTPUT_FORMATS)[number] = "png"
): { content: McpContentItem[]; metadata: ImageMeta[] } {
  const content: McpContentItem[] = [];
  const metadata: ImageMeta[] = [];
  const mimeType = `image/${outputFormat === "jpeg" ? "jpeg" : outputFormat}`;

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const meta: ImageMeta = { index: i + 1 };

    if (img.revised_prompt) {
      meta.revised_prompt = img.revised_prompt;
    }

    // gpt-image models always return b64_json (no URL option)
    if (img.b64_json) {
      const saveDir = outputDirectory ?? getDefaultOutputDir();
      const filename = `${prefix}_${Date.now()}_${i + 1}.${outputFormat}`;
      const filepath = path.join(saveDir, filename);
      fs.writeFileSync(filepath, Buffer.from(img.b64_json, "base64"));
      meta.saved_path = filepath;

      // Only embed inline if small enough to avoid hitting MCP's 20 MB response limit
      if (img.b64_json.length <= MCP_INLINE_SIZE_LIMIT) {
        content.push({
          type: "image",
          data: img.b64_json,
          mimeType,
        });
      }
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
  version: "2.0.0",
});

// ---------------------------------------------------------------------------
// Tool 1: gpt_image_generate
// ---------------------------------------------------------------------------

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
      .enum(IMAGE_MODELS)
      .default("gpt-image-2")
      .describe(
        "Image generation model. " +
          "'gpt-image-2' (default) is the latest state-of-the-art model — no transparent background. " +
          "'gpt-image-1.5' is fast and supports transparent backgrounds. " +
          "'gpt-image-1-mini' is the most cost-efficient option. " +
          "'gpt-image-1' is the legacy model."
      ),
    n: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(1)
      .describe("Number of images to generate (1–10)."),
    size: z
      .enum(IMAGE_SIZES)
      .default("1024x1024")
      .describe(
        "Dimensions of the generated image. " +
          "'auto' lets the model pick the best aspect ratio for the prompt."
      ),
    quality: z
      .enum(IMAGE_QUALITIES)
      .optional()
      .describe(
        "Image quality. 'low' is fastest/cheapest, 'high' produces the finest detail. " +
          "'auto' lets the model pick. Defaults to the model's own default if omitted."
      ),
    background: z
      .enum(BACKGROUND_OPTIONS)
      .optional()
      .describe(
        "Background handling. 'transparent' requires output_format='png' or 'webp'. " +
          "Not supported on gpt-image-2."
      ),
    output_format: z
      .enum(OUTPUT_FORMATS)
      .default("png")
      .describe("Output image file format."),
    output_compression: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe(
        "Compression level (0–100) for jpeg/webp output. Ignored for png."
      ),
    output_directory: z
      .string()
      .optional()
      .describe(
        "Directory to save generated images. Images are always returned as base64 " +
          "and written to disk. Defaults to './openai-image-gen' if omitted."
      ),
  })
  .strict();

type GenerateImageInput = z.infer<typeof GenerateImageSchema>;

server.registerTool(
  "gpt_image_generate",
  {
    title: "Generate Image",
    description: `Generate one or more images from a text prompt using OpenAI's gpt-image models.

All images are returned as base64 data and saved to disk (gpt-image models do not produce URLs).

Args:
  - prompt (string, required): Text description. Max 4000 chars.
  - model ('gpt-image-1'|'gpt-image-1-mini'|'gpt-image-1.5'|'gpt-image-2'): Default: 'gpt-image-2'
  - n (number): Images to generate, 1–10. Default: 1
  - size ('1024x1024'|'1024x1536'|'1536x1024'|'auto'): Dimensions. Default: '1024x1024'
  - quality ('low'|'medium'|'high'|'auto'): Quality level. Optional.
  - background ('transparent'|'opaque'|'auto'): Transparent background requires png/webp. Not supported on gpt-image-2. Optional.
  - output_format ('png'|'jpeg'|'webp'): Output file format. Default: 'png'
  - output_compression (number, 0–100): Compression for jpeg/webp. Optional.
  - output_directory (string): Directory to save files. Defaults to './openai-image-gen'. Optional.

Returns:
  - Embedded base64 image data (if under size limit)
  - Metadata: model used, saved file paths

Examples:
  - "A photorealistic portrait of a tabby cat sitting on a windowsill"
  - model="gpt-image-2", quality="high", prompt="Detailed oil painting of a medieval castle"
  - size="1536x1024", prompt="Wide cinematic shot of a foggy mountain valley at sunrise"
  - background="transparent", prompt="A glowing magic crystal, PNG with transparent bg"`,
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
      if (params.background === "transparent" && params.output_format === "jpeg") {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: "Error: background='transparent' requires output_format='png' or 'webp' (jpeg has no alpha channel).",
            },
          ],
        };
      }

      if (params.model === "gpt-image-2" && params.background === "transparent") {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text:
                "Error: gpt-image-2 does not support transparent backgrounds. " +
                "Use gpt-image-1, gpt-image-1-mini, or gpt-image-1.5 instead.",
            },
          ],
        };
      }

      if (params.output_directory) {
        const dirError = validateOutputDirectory(params.output_directory);
        if (dirError) {
          return { isError: true, content: [{ type: "text" as const, text: dirError }] };
        }
      }

      const client = getClient();

      // gpt-image parameters are passed through; cast via `any` because the installed
      // openai SDK typings predate the full gpt-image schema (background/output_format/etc.).
      const requestParams: Record<string, unknown> = {
        prompt: params.prompt,
        model: params.model,
        n: params.n,
        size: params.size,
      };

      if (params.quality) requestParams.quality = params.quality;
      if (params.background) requestParams.background = params.background;
      if (params.output_format) requestParams.output_format = params.output_format;
      if (params.output_compression !== undefined) {
        requestParams.output_compression = params.output_compression;
      }

      const response = await client.images.generate(
        requestParams as unknown as OpenAI.Images.ImageGenerateParams
      );
      const images = response.data ?? [];

      const { content, metadata } = collectImageContent(
        images,
        params.output_directory,
        "generated",
        params.output_format
      );

      const summaryLines = [
        `Generated ${images.length} image(s) with ${params.model}`,
        `Prompt: "${params.prompt}"`,
      ];
      for (const m of metadata) {
        summaryLines.push(`\nImage ${m.index}:`);
        if (m.revised_prompt) summaryLines.push(`  Revised prompt: ${m.revised_prompt}`);
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
          "Must be PNG format, under 25 MB. " +
          "Oversized images are automatically resized. RGB images are auto-converted to RGBA."
      ),
    prompt: z
      .string()
      .min(1, "Prompt is required")
      .max(32000, "Prompt must not exceed 32000 characters")
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
      .enum(IMAGE_MODELS)
      .default("gpt-image-2")
      .describe(
        "Editing model. 'gpt-image-2' (default) is the highest quality but has no transparent background. " +
          "Use 'gpt-image-1.5' when you need transparent-bg editing."
      ),
    n: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(1)
      .describe("Number of edited images to produce (1–10)."),
    size: z
      .enum(IMAGE_SIZES)
      .default("1024x1024")
      .describe("Output dimensions. 'auto' lets the model pick."),
    quality: z
      .enum(IMAGE_QUALITIES)
      .optional()
      .describe("Quality level (low/medium/high/auto). Optional."),
    background: z
      .enum(BACKGROUND_OPTIONS)
      .optional()
      .describe(
        "Background handling. 'transparent' requires output_format='png' or 'webp'. " +
          "Not supported on gpt-image-2."
      ),
    output_format: z
      .enum(OUTPUT_FORMATS)
      .default("png")
      .describe("Output image file format."),
    output_compression: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe("Compression level (0–100) for jpeg/webp output."),
    output_directory: z
      .string()
      .optional()
      .describe(
        "Directory to save edited images. Defaults to './openai-image-gen' if omitted."
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
  - image_path (string, required): Absolute path to PNG image (< 25 MB). Auto-resized if over limit. RGB auto-converted to RGBA.
  - prompt (string, required): Description of the desired edit.
  - mask_path (string): Absolute path to PNG mask. Transparent pixels = edit zone. Optional.
  - model ('gpt-image-1'|'gpt-image-1-mini'|'gpt-image-1.5'|'gpt-image-2'): Default: 'gpt-image-2'
  - n (number): Number of results (1–10). Default: 1
  - size ('1024x1024'|'1024x1536'|'1536x1024'|'auto'): Output size. Default: '1024x1024'
  - quality ('low'|'medium'|'high'|'auto'): Quality level. Optional.
  - background ('transparent'|'opaque'|'auto'): Not supported on gpt-image-2. Optional.
  - output_format ('png'|'jpeg'|'webp'): Default: 'png'
  - output_compression (0–100): For jpeg/webp. Optional.
  - output_directory (string): Save directory. Defaults to './openai-image-gen'. Optional.

Returns:
  - Edited image(s) as embedded base64 data and saved file paths.

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

      if (params.background === "transparent" && params.output_format === "jpeg") {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: "Error: background='transparent' requires output_format='png' or 'webp'.",
            },
          ],
        };
      }

      if (params.model === "gpt-image-2" && params.background === "transparent") {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: "Error: gpt-image-2 does not support transparent backgrounds.",
            },
          ],
        };
      }

      const { resolvedPath: resolvedImagePath, resizeNote: imageResizeNote } =
        await resizeImageToFitLimit(params.image_path, MAX_IMAGE_UPLOAD_BYTES);

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
          await resizeImageToFitLimit(params.mask_path, MAX_IMAGE_UPLOAD_BYTES));
      }

      if (params.output_directory) {
        const dirError = validateOutputDirectory(params.output_directory);
        if (dirError) {
          return { isError: true, content: [{ type: "text" as const, text: dirError }] };
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

      const requestParams: Record<string, unknown> = {
        image: await toFile(fs.createReadStream(rgbaImagePath), imageName, { type: "image/png" }),
        prompt: params.prompt,
        model: params.model,
        n: params.n,
        size: params.size,
      };

      if (params.quality) requestParams.quality = params.quality;
      if (params.background) requestParams.background = params.background;
      if (params.output_format) requestParams.output_format = params.output_format;
      if (params.output_compression !== undefined) {
        requestParams.output_compression = params.output_compression;
      }

      if (rgbaMaskPath) {
        const maskName = path.basename(rgbaMaskPath);
        requestParams.mask = await toFile(
          fs.createReadStream(rgbaMaskPath),
          maskName,
          { type: "image/png" }
        );
      }

      const response = await client.images.edit(
        requestParams as unknown as OpenAI.Images.ImageEditParams
      );
      const images = response.data ?? [];

      const { content, metadata } = collectImageContent(
        images,
        params.output_directory,
        "edited",
        params.output_format
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

const DEFAULT_VARIATION_PROMPT =
  "Create a new artistic variation of this image. Preserve the main subject and overall " +
  "composition but introduce distinct variations in style, lighting, color palette, mood, " +
  "or framing. Produce a recognizable but visually different interpretation of the source.";

const CreateVariationSchema = z
  .object({
    image_path: z
      .string()
      .min(1, "image_path is required")
      .describe(
        "Absolute path to the PNG image file to vary. Under 25 MB. Auto-resized if larger."
      ),
    variation_prompt: z
      .string()
      .max(32000)
      .optional()
      .describe(
        "Optional custom prompt describing the kind of variation to produce. " +
          "If omitted, a default 'stylistic variation' prompt is used."
      ),
    model: z
      .enum(IMAGE_MODELS)
      .default("gpt-image-2")
      .describe(
        "Model for variation (implemented via the edit endpoint). Default: 'gpt-image-2'"
      ),
    n: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(1)
      .describe("Number of variations to generate (1–10)."),
    size: z
      .enum(IMAGE_SIZES)
      .default("1024x1024")
      .describe("Output dimensions. 'auto' lets the model pick."),
    quality: z
      .enum(IMAGE_QUALITIES)
      .optional()
      .describe("Quality level. Optional."),
    output_format: z
      .enum(OUTPUT_FORMATS)
      .default("png")
      .describe("Output image file format."),
    output_compression: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe("Compression level (0–100) for jpeg/webp."),
    output_directory: z
      .string()
      .optional()
      .describe("Directory to save files. Defaults to './openai-image-gen'."),
  })
  .strict();

type CreateVariationInput = z.infer<typeof CreateVariationSchema>;

server.registerTool(
  "gpt_image_create_variation",
  {
    title: "Create Image Variation",
    description: `Create one or more artistic variations of an existing image.

Implemented on top of the gpt-image edit endpoint because the legacy DALL-E 2 variations endpoint
was retired on 2026-05-12. Pass a custom 'variation_prompt' for targeted variations, or rely on the
default "stylistic variation" prompt for generic reinterpretations.

Args:
  - image_path (string, required): Absolute path to source PNG (< 25 MB).
  - variation_prompt (string): Custom instruction for the variation. Optional.
  - model ('gpt-image-1'|'gpt-image-1-mini'|'gpt-image-1.5'|'gpt-image-2'): Default: 'gpt-image-2'
  - n (number): Number of variations (1–10). Default: 1
  - size ('1024x1024'|'1024x1536'|'1536x1024'|'auto'): Default: '1024x1024'
  - quality ('low'|'medium'|'high'|'auto'): Optional.
  - output_format ('png'|'jpeg'|'webp'): Default: 'png'
  - output_compression (0–100): For jpeg/webp. Optional.
  - output_directory (string): Save directory. Defaults to './openai-image-gen'.

Returns:
  - Variation image(s) as embedded base64 data and saved file paths.

Examples:
  - 3 variations: image_path="/art/original.png", n=3
  - Targeted: image_path="/photo.png", variation_prompt="Reinterpret as oil painting with warm sunset tones"`,
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
        await resizeImageToFitLimit(params.image_path, MAX_IMAGE_UPLOAD_BYTES);

      if (params.output_directory) {
        const dirError = validateOutputDirectory(params.output_directory);
        if (dirError) {
          return { isError: true, content: [{ type: "text" as const, text: dirError }] };
        }
      }

      const { resolvedPath: rgbaImagePath, convertNote } = await ensureRGBA(resolvedImagePath);

      const client = getClient();
      const imageName = path.basename(rgbaImagePath);
      const variationPrompt = params.variation_prompt ?? DEFAULT_VARIATION_PROMPT;

      const requestParams: Record<string, unknown> = {
        image: await toFile(fs.createReadStream(rgbaImagePath), imageName, { type: "image/png" }),
        prompt: variationPrompt,
        model: params.model,
        n: params.n,
        size: params.size,
      };
      if (params.quality) requestParams.quality = params.quality;
      if (params.output_format) requestParams.output_format = params.output_format;
      if (params.output_compression !== undefined) {
        requestParams.output_compression = params.output_compression;
      }

      const response = await client.images.edit(
        requestParams as unknown as OpenAI.Images.ImageEditParams
      );
      const images = response.data ?? [];

      const { content, metadata } = collectImageContent(
        images,
        params.output_directory,
        "variation",
        params.output_format
      );

      const summaryLines = [
        `Created ${images.length} variation(s) with ${params.model} (via edit endpoint)`,
        `Source: ${params.image_path}`,
        `Prompt: "${variationPrompt}"`,
      ];
      if (resizeNote) summaryLines.push(resizeNote);
      if (convertNote) summaryLines.push(convertNote);
      for (const m of metadata) {
        summaryLines.push(`\nVariation ${m.index}:`);
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
// Tools 4–6: Character reference + pose generation + sprite sheet
// ---------------------------------------------------------------------------

/**
 * Removes white/near-white background pixels using flood-fill from image corners.
 * Only background pixels reachable from the edges are made transparent,
 * preserving white areas that are part of the character itself.
 */
async function removeWhiteBackground(
  imagePath: string,
  threshold: number
): Promise<Buffer> {
  const { data, info } = await sharp(imagePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = new Uint8Array(data);
  const { width, height } = info;
  const visited = new Uint8Array(width * height);

  const isWhite = (x: number, y: number): boolean => {
    const idx = (y * width + x) * 4;
    return pixels[idx] > threshold && pixels[idx + 1] > threshold && pixels[idx + 2] > threshold;
  };

  // BFS flood-fill from all edge pixels
  const queue: number[] = [];
  const enqueue = (x: number, y: number) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const pos = y * width + x;
    if (visited[pos] || !isWhite(x, y)) return;
    visited[pos] = 1;
    queue.push(x, y);
  };

  for (let x = 0; x < width; x++) { enqueue(x, 0); enqueue(x, height - 1); }
  for (let y = 0; y < height; y++) { enqueue(0, y); enqueue(width - 1, y); }

  let qi = 0;
  while (qi < queue.length) {
    const x = queue[qi++];
    const y = queue[qi++];
    enqueue(x + 1, y); enqueue(x - 1, y);
    enqueue(x, y + 1); enqueue(x, y - 1);
  }

  // Make only the flood-filled (background) pixels transparent
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (visited[y * width + x]) {
        const idx = (y * width + x) * 4;
        pixels[idx + 3] = 0;
      }
    }
  }

  return sharp(Buffer.from(pixels), {
    raw: { width, height, channels: 4 },
  })
    .png()
    .toBuffer();
}

/**
 * Crops the image to the bounding box of non-transparent content.
 */
async function cropToContent(imageBuffer: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(imageBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = new Uint8Array(data);
  let minX = info.width, maxX = 0, minY = info.height, maxY = 0;

  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const idx = (y * info.width + x) * 4;
      if (pixels[idx + 3] > 10) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (minX > maxX || minY > maxY) return imageBuffer;

  return sharp(imageBuffer)
    .extract({ left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 })
    .toBuffer();
}

// ---------------------------------------------------------------------------
// Shared helper: generate a pose from a reference image (b64)
// ---------------------------------------------------------------------------

async function generatePoseFromReference(
  client: OpenAI,
  referenceB64: string,
  poseDescription: string,
  characterDescription: string,
  quality: string,
  tmpDir: string
): Promise<string> {
  const srcPath = path.join(tmpDir, `pose_src_${Date.now()}.png`);
  fs.writeFileSync(srcPath, Buffer.from(referenceB64, "base64"));

  const editPrompt =
    `Redraw this exact character in the following pose or action: ${poseDescription}. ` +
    `Preserve every visual detail from the reference image exactly — ` +
    `same face, same body shape and proportions, same outfit and colors, same accessories and items. ` +
    `Only the pose or action changes. Nothing is added or removed. ` +
    `Character description for reference: ${characterDescription}. ` +
    `Pure white background. Full body visible including all accessories.`;

  const response = await client.images.edit({
    image: await toFile(fs.createReadStream(srcPath), "reference.png", { type: "image/png" }),
    prompt: editPrompt,
    model: INTERNAL_IMAGE_MODEL,
    size: "1024x1024",
    ...(quality ? { quality: quality as OpenAI.Images.ImageEditParams["quality"] } : {}),
  });

  fs.unlinkSync(srcPath);
  return response.data?.[0]?.b64_json ?? "";
}

// ---------------------------------------------------------------------------
// Shared helper: process a raw b64 image → remove bg → crop → Buffer
// ---------------------------------------------------------------------------

async function processFrame(
  b64: string,
  bgThreshold: number,
  tmpDir: string
): Promise<Buffer> {
  const tmpPath = path.join(tmpDir, `frame_${Date.now()}.png`);
  fs.writeFileSync(tmpPath, Buffer.from(b64, "base64"));
  const noBg = await removeWhiteBackground(tmpPath, bgThreshold);
  const cropped = await cropToContent(noBg);
  fs.unlinkSync(tmpPath);
  return cropped;
}

// ---------------------------------------------------------------------------
// Tool 4: gpt_image_create_character_reference
// ---------------------------------------------------------------------------

const CreateCharacterReferenceSchema = z
  .object({
    character_description: z
      .string()
      .min(1)
      .max(3000)
      .describe(
        "Description of the character's appearance — colors, clothing, accessories, art style. " +
          "Be as specific as possible. This image will be used as the visual reference for all future poses."
      ),
    output_path: z
      .string()
      .min(1)
      .describe(
        "Absolute path (including filename) where the reference PNG will be saved. " +
          "Example: '/project/assets/sprites/hero_ref.png'"
      ),
    quality: z
      .enum(["low", "medium", "high"])
      .default("high")
      .optional()
      .describe("gpt-image-1 quality level. Default: 'high'"),
    bg_threshold: z
      .number()
      .int()
      .min(0)
      .max(255)
      .default(240)
      .optional()
      .describe("White background removal threshold (0–255). Default: 240"),
  })
  .strict();

type CreateCharacterReferenceInput = z.infer<typeof CreateCharacterReferenceSchema>;

server.registerTool(
  "gpt_image_create_character_reference",
  {
    title: "Create Character Reference",
    description: `Generate a base reference image for a game character on a transparent background.

This is the first step in a two-step workflow:
  1. gpt_image_create_character_reference — create the base character (this tool)
  2. gpt_image_generate_pose — generate any pose using the reference

The reference image is a front-facing neutral stance. Save it and use its path
with gpt_image_generate_pose to create consistent walking, attacking, crying,
jumping, or any other animation frames.

Args:
  - character_description (string, required): Full appearance description. Max 3000 chars.
  - output_path (string, required): Absolute path for the output PNG.
  - quality ('low'|'medium'|'high'): gpt-image-1 quality. Default: 'high'
  - bg_threshold (number): Background removal threshold (0–255). Default: 240

Returns:
  - Saved reference image path

Example:
  - character_description="cute chibi goose, white feathers, orange beak, blue sailor hat, red bow tie"
    output_path="/project/assets/sprites/goose_ref.png"`,
    inputSchema: CreateCharacterReferenceSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (params: CreateCharacterReferenceInput) => {
    try {
      const outputDir = path.dirname(params.output_path);
      if (!fs.existsSync(outputDir)) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error: Output directory does not exist: ${outputDir}` }],
        };
      }

      const client = getClient();
      const quality = params.quality ?? "high";
      const bgThreshold = params.bg_threshold ?? 240;
      const tmpDir = os.tmpdir();

      const prompt =
        `A single 2D game character sprite on a pure white background. ` +
        `Character: ${params.character_description}. ` +
        `Neutral front-facing stance, body relaxed, arms at sides. ` +
        `Full body completely visible — top of head to feet, all accessories included. ` +
        `Character occupies center 60% of image height with generous white margin on all sides. ` +
        `Clean cartoon style, clear black outlines, flat colors, soft shading. No shadows.`;

      const response = await client.images.generate({
        prompt,
        model: INTERNAL_IMAGE_MODEL,
        size: "1024x1024",
        quality: quality as OpenAI.Images.ImageGenerateParams["quality"],
      });

      const b64 = response.data?.[0]?.b64_json ?? "";
      if (!b64) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: "Error: Image generation returned empty data." }],
        };
      }

      const processed = await processFrame(b64, bgThreshold, tmpDir);
      fs.writeFileSync(params.output_path, processed);

      const refContent: McpContentItem[] = [
        {
          type: "text" as const,
          text: `Character reference saved: ${params.output_path}\nUse this path with gpt_image_generate_pose to create any pose.`,
        },
      ];
      if (b64.length <= MCP_INLINE_SIZE_LIMIT) {
        refContent.push({ type: "image" as const, data: b64, mimeType: "image/png" });
      }
      return { content: refContent };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: handleOpenAIError(error) }],
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 5: gpt_image_generate_pose
// ---------------------------------------------------------------------------

const GeneratePoseSchema = z
  .object({
    reference_image_path: z
      .string()
      .min(1)
      .describe(
        "Absolute path to the character reference PNG (created by gpt_image_create_character_reference). " +
          "This image is used to maintain visual consistency."
      ),
    character_description: z
      .string()
      .min(1)
      .max(3000)
      .describe(
        "The same character description used when creating the reference. " +
          "Helps the model preserve appearance details."
      ),
    pose_description: z
      .string()
      .min(1)
      .max(1000)
      .describe(
        "Free-text description of the pose or action to generate. " +
          "Examples: 'walking, left foot forward', 'crying with tears', 'jumping with arms raised', " +
          "'attacking with sword', 'sitting cross-legged', 'waving hello'"
      ),
    output_path: z
      .string()
      .min(1)
      .describe("Absolute path (including filename) where the pose PNG will be saved."),
    quality: z
      .enum(["low", "medium", "high"])
      .default("high")
      .optional()
      .describe("gpt-image-1 quality level. Default: 'high'"),
    bg_threshold: z
      .number()
      .int()
      .min(0)
      .max(255)
      .default(240)
      .optional()
      .describe("White background removal threshold (0–255). Default: 240"),
  })
  .strict();

type GeneratePoseInput = z.infer<typeof GeneratePoseSchema>;

server.registerTool(
  "gpt_image_generate_pose",
  {
    title: "Generate Character Pose",
    description: `Generate a specific pose or action frame for a character, using a reference image for visual consistency.

Use this after gpt_image_create_character_reference to create any animation frames:
walking, running, jumping, attacking, crying, waving, sitting, etc.

Args:
  - reference_image_path (string, required): Path to the reference PNG from gpt_image_create_character_reference.
  - character_description (string, required): Same description used for the reference.
  - pose_description (string, required): Free-text pose or action. Max 1000 chars.
  - output_path (string, required): Absolute path for the output PNG.
  - quality ('low'|'medium'|'high'): gpt-image-1 quality. Default: 'high'
  - bg_threshold (number): Background removal threshold (0–255). Default: 240

Returns:
  - Saved pose image path and inline preview

Examples:
  - pose_description="walking with left foot forward"
  - pose_description="crying, tears streaming down face, eyes closed"
  - pose_description="jumping high with both arms raised in celebration"
  - pose_description="attacking, swinging sword to the right"`,
    inputSchema: GeneratePoseSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (params: GeneratePoseInput) => {
    try {
      if (!fs.existsSync(params.reference_image_path)) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error: Reference image not found: ${params.reference_image_path}` }],
        };
      }
      const outputDir = path.dirname(params.output_path);
      if (!fs.existsSync(outputDir)) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error: Output directory does not exist: ${outputDir}` }],
        };
      }

      const client = getClient();
      const quality = params.quality ?? "high";
      const bgThreshold = params.bg_threshold ?? 240;
      const tmpDir = os.tmpdir();

      const refB64 = fs.readFileSync(params.reference_image_path).toString("base64");
      const b64 = await generatePoseFromReference(
        client, refB64, params.pose_description,
        params.character_description, quality, tmpDir
      );
      if (!b64) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: "Error: Pose generation returned empty data." }],
        };
      }

      const processed = await processFrame(b64, bgThreshold, tmpDir);
      fs.writeFileSync(params.output_path, processed);

      const poseContent: McpContentItem[] = [
        { type: "text" as const, text: `Pose saved: ${params.output_path}` },
      ];
      if (b64.length <= MCP_INLINE_SIZE_LIMIT) {
        poseContent.push({ type: "image" as const, data: b64, mimeType: "image/png" });
      }
      return { content: poseContent };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: handleOpenAIError(error) }],
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 6: gpt_image_generate_sprite_sheet
// ---------------------------------------------------------------------------

const GenerateSpriteSheetSchema = z
  .object({
    character_description: z
      .string()
      .min(1)
      .max(3000)
      .describe(
        "Description of the character's appearance. Be specific — used to generate the reference and all pose frames."
      ),
    poses: z
      .array(z.string().min(1).max(500))
      .min(1)
      .max(10)
      .optional()
      .describe(
        "List of pose descriptions for each frame. " +
          "Defaults to a 3-frame walk cycle if omitted. " +
          "Examples: ['walking left foot forward', 'neutral stance', 'walking right foot forward']"
      ),
    output_path: z
      .string()
      .min(1)
      .describe(
        "Absolute path (including filename) where the final sprite sheet PNG will be saved."
      ),
    quality: z
      .enum(["low", "medium", "high"])
      .default("high")
      .optional()
      .describe("gpt-image-1 quality level. Default: 'high'"),
    bg_threshold: z
      .number()
      .int()
      .min(0)
      .max(255)
      .default(240)
      .optional()
      .describe("White background removal threshold (0–255). Default: 240"),
    frame_gap: z
      .number()
      .int()
      .min(0)
      .max(200)
      .default(0)
      .optional()
      .describe("Gap in pixels between frames. Default: 0"),
  })
  .strict();

type GenerateSpriteSheetInput = z.infer<typeof GenerateSpriteSheetSchema>;

const DEFAULT_WALK_POSES = [
  "walking, left foot stepping forward, mid-stride",
  "neutral upright stance, both feet together",
  "walking, right foot stepping forward, mid-stride",
];

server.registerTool(
  "gpt_image_generate_sprite_sheet",
  {
    title: "Generate Sprite Sheet",
    description: `Generate a multi-frame sprite sheet for a game character.

Internally creates a reference image from the character description, then generates
each requested pose using that reference for visual consistency. Frames are combined
side-by-side into a single transparent-background PNG.

For more control, use the two-step workflow instead:
  1. gpt_image_create_character_reference
  2. gpt_image_generate_pose (called once per frame)

Args:
  - character_description (string, required): Appearance of the character. Max 3000 chars.
  - poses (string[]): Pose descriptions for each frame. Defaults to a 3-frame walk cycle.
  - output_path (string, required): Absolute path for the output sprite sheet PNG.
  - quality ('low'|'medium'|'high'): gpt-image-1 quality. Default: 'high'
  - bg_threshold (number): Background removal threshold (0–255). Default: 240
  - frame_gap (number): Pixel gap between frames. Default: 0

Returns:
  - Saved sprite sheet path and dimensions

Examples:
  - 3-frame walk cycle (default):
      character_description="chibi knight in silver armor"
      output_path="/sprites/knight_walk.png"

  - Custom poses:
      character_description="cute goose with sailor hat"
      poses=["walking left foot forward", "waving hello with right wing", "sitting"]
      output_path="/sprites/goose_actions.png"`,
    inputSchema: GenerateSpriteSheetSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (params: GenerateSpriteSheetInput) => {
    try {
      const outputDir = path.dirname(params.output_path);
      if (!fs.existsSync(outputDir)) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error: Output directory does not exist: ${outputDir}` }],
        };
      }

      const client = getClient();
      const quality = params.quality ?? "high";
      const bgThreshold = params.bg_threshold ?? 240;
      const frameGap = params.frame_gap ?? 0;
      const poses = params.poses ?? DEFAULT_WALK_POSES;
      const tmpDir = os.tmpdir();

      // Step 1: Generate reference
      const refPrompt =
        `A single 2D game character sprite on a pure white background. ` +
        `Character: ${params.character_description}. ` +
        `Neutral front-facing stance, body relaxed, arms at sides. ` +
        `Full body completely visible — top of head to feet, all accessories included. ` +
        `Character occupies center 60% of image height with generous white margin on all sides. ` +
        `Clean cartoon style, clear black outlines, flat colors, soft shading. No shadows.`;

      const refResponse = await client.images.generate({
        prompt: refPrompt,
        model: INTERNAL_IMAGE_MODEL,
        size: "1024x1024",
        quality: quality as OpenAI.Images.ImageGenerateParams["quality"],
      });
      const refB64 = refResponse.data?.[0]?.b64_json ?? "";
      if (!refB64) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: "Error: Reference frame returned empty data." }],
        };
      }

      // Step 2: Generate each pose from the reference
      const processedBuffers: Buffer[] = [];
      for (let i = 0; i < poses.length; i++) {
        const b64 = await generatePoseFromReference(
          client, refB64, poses[i], params.character_description, quality, tmpDir
        );
        if (!b64) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: `Error: Frame ${i + 1} returned empty data.` }],
          };
        }
        processedBuffers.push(await processFrame(b64, bgThreshold, tmpDir));
      }

      // Step 3: Pad all frames to same size and combine horizontally
      const metaList = await Promise.all(processedBuffers.map((buf) => sharp(buf).metadata()));
      const maxW = Math.max(...metaList.map((m) => m.width ?? 0));
      const maxH = Math.max(...metaList.map((m) => m.height ?? 0));

      const paddedBuffers = await Promise.all(
        processedBuffers.map(async (buf, i) => {
          const w = metaList[i].width ?? maxW;
          const h = metaList[i].height ?? maxH;
          return sharp({
            create: { width: maxW, height: maxH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
          })
            .png()
            .composite([{ input: buf, left: Math.floor((maxW - w) / 2), top: Math.floor((maxH - h) / 2) }])
            .toBuffer();
        })
      );

      const totalWidth = maxW * poses.length + frameGap * (poses.length - 1);
      await sharp({
        create: { width: totalWidth, height: maxH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
      })
        .png()
        .composite(paddedBuffers.map((buf, i) => ({ input: buf, left: i * (maxW + frameGap), top: 0 })))
        .toFile(params.output_path);

      return {
        content: [{
          type: "text" as const,
          text: [
            `Generated sprite sheet: ${params.output_path}`,
            `Dimensions: ${totalWidth}x${maxH} (${poses.length} frames × ${maxW}x${maxH}, gap: ${frameGap}px)`,
            `Poses: ${poses.map((p, i) => `\n  [${i + 1}] ${p}`).join("")}`,
          ].join("\n"),
        }],
      };
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
