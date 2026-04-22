# openai-image-mcp-server

An MCP server for OpenAI image generation. Generate, edit, and create variations of images using the gpt-image model family (`gpt-image-1`, `gpt-image-1-mini`, `gpt-image-1.5`, `gpt-image-2`) — directly from any MCP-compatible client like Claude Desktop, Cursor, or VS Code.

> **DALL-E 2 / DALL-E 3 removed.** OpenAI retired both DALL-E models on 2026-05-12. This server now targets only the gpt-image family. The `gpt_image_create_variation` tool is re-implemented on top of the edit endpoint because the legacy `/v1/images/variations` endpoint went away with DALL-E 2.

## Tools

| Tool | Description |
|---|---|
| `gpt_image_generate` | Generate images from a text prompt |
| `gpt_image_edit` | Edit an existing image with inpainting/masking |
| `gpt_image_create_variation` | Create stylistic variations of an image (via edit endpoint) |
| `gpt_image_create_character_reference` | Generate a base reference image for a game character |
| `gpt_image_generate_pose` | Generate any pose/action from a character reference image |
| `gpt_image_generate_sprite_sheet` | Generate a multi-frame sprite sheet (convenience wrapper) |

## Requirements

- Node.js 18+
- An [OpenAI API key](https://platform.openai.com/api-keys)

## Installation

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "gpt-image-gen": {
      "command": "npx",
      "args": ["-y", "openai-image-mcp-server@latest"],
      "env": {
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

### Cursor

Add to your Cursor MCP settings (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "gpt-image-gen": {
      "command": "npx",
      "args": ["-y", "openai-image-mcp-server@latest"],
      "env": {
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

### VS Code (with Copilot MCP extension)

Add to your VS Code `settings.json`:

```json
{
  "mcp.servers": {
    "gpt-image-gen": {
      "command": "npx",
      "args": ["-y", "openai-image-mcp-server@latest"],
      "env": {
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

### Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "env": {
    "OPENAI_API_KEY": "sk-..."
  },
  "mcpServers": {
    "openai-image": {
      "command": "npx",
      "args": ["-y", "openai-image-mcp-server"]
    }
  }
}
```

Or via CLI:

```bash
claude mcp add openai-image -e OPENAI_API_KEY=sk-... -- npx -y openai-image-mcp-server@latest
```

### Manual (from source)

```bash
git clone https://github.com/YOUR_USERNAME/openai-image-mcp-server
cd openai-image-mcp-server
npm install
npm run build

OPENAI_API_KEY=sk-... node dist/index.js
```

## Tool Reference

### `gpt_image_generate`

Generate one or more images from a text prompt.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `prompt` | string | required | Text description of the image |
| `model` | `gpt-image-1` \| `gpt-image-1-mini` \| `gpt-image-1.5` \| `gpt-image-2` | `gpt-image-2` | Model to use |
| `n` | number (1–10) | `1` | Number of images |
| `size` | `1024x1024` \| `1024x1536` \| `1536x1024` \| `auto` | `1024x1024` | Output dimensions |
| `quality` | `low` \| `medium` \| `high` \| `auto` | — | Quality level |
| `background` | `transparent` \| `opaque` \| `auto` | — | Transparent requires png/webp. Not supported on gpt-image-2 |
| `output_format` | `png` \| `jpeg` \| `webp` | `png` | Output file format |
| `output_compression` | number (0–100) | — | Compression for jpeg/webp |
| `output_directory` | string | `./openai-image-gen` | Directory for saved files |

> Images are always returned as base64 data and written to disk. gpt-image models do not produce URLs.

**Examples:**

```
Generate a photorealistic portrait of a tabby cat sitting on a windowsill
```

```
Generate a wide cinematic shot of a foggy mountain valley at sunrise
  → model: gpt-image-2, size: 1536x1024, quality: high
```

```
Generate a glowing magic crystal with transparent background
  → background: transparent, output_format: png
```

---

### `gpt_image_edit`

Edit an existing image using a text prompt. Supports inpainting with an optional mask — transparent pixels in the mask define the region to edit.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `image_path` | string | required | Absolute path to source PNG (< 25 MB, auto-resized) |
| `prompt` | string | required | Description of the desired edit |
| `mask_path` | string | — | Absolute path to mask PNG (transparent = edit zone) |
| `model` | `gpt-image-1` \| `gpt-image-1-mini` \| `gpt-image-1.5` \| `gpt-image-2` | `gpt-image-2` | Model to use |
| `n` | number (1–10) | `1` | Number of results |
| `size` | `1024x1024` \| `1024x1536` \| `1536x1024` \| `auto` | `1024x1024` | Output dimensions |
| `quality` | `low` \| `medium` \| `high` \| `auto` | — | Quality level |
| `background` | `transparent` \| `opaque` \| `auto` | — | Not supported on gpt-image-2 |
| `output_format` | `png` \| `jpeg` \| `webp` | `png` | Output file format |
| `output_compression` | number (0–100) | — | Compression for jpeg/webp |
| `output_directory` | string | `./openai-image-gen` | Directory for saved files |

**Examples:**

```
Edit /photos/room.png → "Add a potted plant near the window"
```

```
Edit /photos/portrait.png with mask /photos/mask.png → "Replace background with a sunny beach"
```

---

### `gpt_image_create_variation`

Create artistic variations of an existing image.

Implemented on top of the edit endpoint because the legacy `/v1/images/variations` endpoint was retired with DALL-E 2 on 2026-05-12. Pass `variation_prompt` for targeted variations or rely on the default "stylistic variation" prompt.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `image_path` | string | required | Absolute path to source PNG (< 25 MB) |
| `variation_prompt` | string | built-in default | Custom instruction describing the variation |
| `model` | `gpt-image-1` \| `gpt-image-1-mini` \| `gpt-image-1.5` \| `gpt-image-2` | `gpt-image-2` | Model to use |
| `n` | number (1–10) | `1` | Number of variations |
| `size` | `1024x1024` \| `1024x1536` \| `1536x1024` \| `auto` | `1024x1024` | Output dimensions |
| `quality` | `low` \| `medium` \| `high` \| `auto` | — | Quality level |
| `output_format` | `png` \| `jpeg` \| `webp` | `png` | Output file format |
| `output_compression` | number (0–100) | — | Compression for jpeg/webp |
| `output_directory` | string | `./openai-image-gen` | Directory for saved files |

**Examples:**

```
Create 3 variations of /art/original.png
  → n: 3, output_directory: /art/variations
```

```
Reinterpret /photo.png as oil painting with warm sunset tones
  → variation_prompt: "Reinterpret as oil painting with warm sunset tones"
```

---

### `gpt_image_create_character_reference`

Generate a base reference image for a game character on a transparent background. Use this as the first step before generating any poses.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `character_description` | string | required | Full appearance description. Max 3000 chars. |
| `output_path` | string | required | Absolute path for the output PNG |
| `quality` | `low` \| `medium` \| `high` | `high` | gpt-image-1 quality level |
| `bg_threshold` | number (0–255) | `240` | Background removal threshold |

**Example:**

```
Create a character reference for a cute chibi goose
  → character_description: "cute chibi goose, white feathers, orange beak, blue sailor hat, red bow tie"
     output_path: /project/assets/sprites/goose_ref.png
```

---

### `gpt_image_generate_pose`

Generate a specific pose or action frame using a reference image for visual consistency.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `reference_image_path` | string | required | Path to reference PNG from `gpt_image_create_character_reference` |
| `character_description` | string | required | Same description used for the reference |
| `pose_description` | string | required | Free-text pose or action. Max 1000 chars. |
| `output_path` | string | required | Absolute path for the output PNG |
| `quality` | `low` \| `medium` \| `high` | `high` | gpt-image-1 quality level |
| `bg_threshold` | number (0–255) | `240` | Background removal threshold |

**Example poses:**
- `"walking with left foot forward"`
- `"crying, tears streaming down face"`
- `"jumping with both arms raised"`
- `"attacking, swinging sword to the right"`
- `"sitting cross-legged"`
- `"waving hello"`

---

### `gpt_image_generate_sprite_sheet`

Convenience wrapper: generates a reference internally, then produces all requested poses and assembles them into a single sprite sheet. For more control, use `gpt_image_create_character_reference` + `gpt_image_generate_pose` directly.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `character_description` | string | required | Appearance of the character. Max 3000 chars. |
| `poses` | string[] | 3-frame walk cycle | List of pose descriptions for each frame |
| `output_path` | string | required | Absolute path for the output sprite sheet PNG |
| `quality` | `low` \| `medium` \| `high` | `high` | gpt-image-1 quality level |
| `bg_threshold` | number (0–255) | `240` | Background removal threshold |
| `frame_gap` | number | `0` | Pixel gap between frames |

**How it works:**

1. Generates a neutral reference frame with `gpt-image-1`
2. Uses the edit API with the reference to generate each requested pose
3. Removes background (flood-fill from edges, preserves white character parts)
4. Crops each frame to content and pads to uniform dimensions
5. Composites all frames horizontally into a single transparent PNG

**Examples:**

```
3-frame walk cycle (default)
  → character_description: "chibi knight in silver armor with red cape"
     output_path: /sprites/knight_walk.png
```

```
Custom poses
  → character_description: "cute chibi goose, white feathers, blue sailor hat, red bow tie"
     poses: ["walking left foot forward", "waving hello", "sitting down"]
     output_path: /sprites/goose_actions.png
```

```
Aggressive background removal for a character with light-colored clothing
  → character_description: "white-robed healer with golden halo"
     output_path: /sprites/healer.png
     bg_threshold: 200
```

> **Tip:** The more specific your `character_description`, the more consistent the 3 frames will be. Include art style (e.g. "pixel art", "chibi", "flat cartoon"), color details, and any distinctive accessories.

---

## Model Comparison

| | gpt-image-1 | gpt-image-1-mini | gpt-image-1.5 | gpt-image-2 |
|---|---|---|---|---|
| Generate | ✓ | ✓ | ✓ | ✓ |
| Edit | ✓ | ✓ | ✓ | ✓ |
| Variation (via edit) | ✓ | ✓ | ✓ | ✓ |
| Transparent background | ✓ | ✓ | ✓ | ✗ |
| Sizes | 1024² / 1024×1536 / 1536×1024 | same | same | flexible (≤3840px, 16px multiples) |
| Output formats | png / jpeg / webp | same | same | same |
| Best for | Legacy | Cost-efficient bulk | Fast + transparent bg | **Default** · state-of-the-art quality, text rendering |

## Saving Images to Disk

All gpt-image models return base64 data (no URLs). Generated images are automatically written to disk — pass `output_directory` to customize the location, otherwise files land in `./openai-image-gen`.

```
Generate a sunset landscape and save it
  → output_directory: /Users/me/Desktop
```

Files are saved as `generated_<timestamp>_<n>.<ext>`, `edited_<timestamp>_<n>.<ext>`, or `variation_<timestamp>_<n>.<ext>` where `<ext>` matches `output_format` (default `png`).

## License

MIT
