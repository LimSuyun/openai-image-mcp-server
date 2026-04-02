# openai-image-mcp-server

An MCP server for OpenAI image generation. Generate, edit, and create variations of images using DALL-E 2, DALL-E 3, and gpt-image-1 — directly from any MCP-compatible client like Claude Desktop, Cursor, or VS Code.

## Tools

| Tool | Description |
|---|---|
| `gpt_image_generate` | Generate images from a text prompt |
| `gpt_image_edit` | Edit an existing image with inpainting/masking |
| `gpt_image_create_variation` | Create stylistic variations of an image (DALL-E 2) |
| `gpt_image_generate_sprite_sheet` | Generate a 3-frame walking animation sprite sheet for a game character |

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
| `model` | `dall-e-2` \| `dall-e-3` \| `gpt-image-1` | `gpt-image-1` | Model to use |
| `n` | number (1–10) | `1` | Number of images (DALL-E 3 and gpt-image-1 support n=1 only) |
| `size` | see below | `1024x1024` | Output dimensions |
| `quality` | `standard` \| `hd` \| `low` \| `medium` \| `high` | — | Quality level |
| `style` | `vivid` \| `natural` | — | Visual style (DALL-E 3 only) |
| `response_format` | `url` \| `b64_json` | `url` | Return URLs or embedded base64 data |
| `output_directory` | string | — | Save images to this directory (requires `b64_json`) |

**Supported sizes by model:**

| Model | Supported sizes |
|---|---|
| `dall-e-2` | `256x256`, `512x512`, `1024x1024` |
| `dall-e-3` | `1024x1024`, `1792x1024`, `1024x1792` |
| `gpt-image-1` | `1024x1024`, `1792x1024`, `1024x1792` |

**Examples:**

```
Generate a photorealistic portrait of a tabby cat sitting on a windowsill
```

```
Generate a wide cinematic shot of a foggy mountain valley at sunrise
  → model: dall-e-3, size: 1792x1024, quality: hd
```

```
Generate abstract digital art and save it to /Users/me/images
  → response_format: b64_json, output_directory: /Users/me/images
```

---

### `gpt_image_edit`

Edit an existing image using a text prompt. Supports inpainting with an optional mask — transparent pixels in the mask define the region to edit.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `image_path` | string | required | Absolute path to source PNG (square, < 4 MB) |
| `prompt` | string | required | Description of the desired edit |
| `mask_path` | string | — | Absolute path to mask PNG (transparent = edit zone) |
| `model` | `dall-e-2` | `dall-e-2` | Model to use (only dall-e-2 supports editing) |
| `n` | number (1–10) | `1` | Number of results |
| `size` | `256x256` \| `512x512` \| `1024x1024` | `1024x1024` | Output dimensions |
| `response_format` | `url` \| `b64_json` | `url` | Return format |
| `output_directory` | string | — | Save results to this directory (requires `b64_json`) |

**Examples:**

```
Edit /photos/room.png → "Add a potted plant near the window"
```

```
Edit /photos/portrait.png with mask /photos/mask.png → "Replace background with a sunny beach"
```

---

### `gpt_image_create_variation`

Create stylistic variations of an existing image. Uses DALL-E 2.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `image_path` | string | required | Absolute path to source PNG (square, < 4 MB) |
| `n` | number (1–10) | `1` | Number of variations |
| `size` | `256x256` \| `512x512` \| `1024x1024` | `1024x1024` | Output dimensions |
| `response_format` | `url` \| `b64_json` | `url` | Return format |
| `output_directory` | string | — | Save results to this directory (requires `b64_json`) |

**Example:**

```
Create 3 variations of /art/original.png
  → n: 3, response_format: b64_json, output_directory: /art/variations
```

---

### `gpt_image_generate_sprite_sheet`

Generate a 3-frame horizontal walking animation sprite sheet for a game character. Internally generates each frame with `gpt-image-1`, removes the white background, crops to content, aligns frames to a uniform size, and combines them side-by-side into a single transparent-background PNG.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `character_description` | string | required | Appearance of the character (colors, clothing, art style). Max 3000 chars. |
| `output_path` | string | required | Absolute path (including filename) for the output PNG |
| `quality` | `low` \| `medium` \| `high` | `high` | gpt-image-1 quality level |
| `bg_threshold` | number (0–255) | `240` | White background removal aggressiveness — higher removes more |
| `frame_gap` | number | `0` | Pixel gap between frames in the final sheet |

**How it works:**

1. Generates 3 poses in parallel: left-foot step → neutral → right-foot step
2. Removes white/near-white background pixels (controlled by `bg_threshold`)
3. Crops each frame to its non-transparent bounding box
4. Pads all frames to the same dimensions (center-aligned)
5. Composites frames horizontally into a single PNG

**Output:** A single PNG with dimensions `(frameWidth × 3 + frameGap × 2) × frameHeight`.

**Examples:**

```
Generate a sprite sheet for a cute chibi alien commander
  → character_description: "cute chibi alien commander, purple face, dark wizard robe with gold trim, teal orb staff"
     output_path: /project/assets/sprites/alien-commander.png
```

```
Generate a sprite sheet with extra spacing between frames
  → character_description: "medieval knight in silver armor with red cape"
     output_path: /game/sprites/knight.png
     frame_gap: 8
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

| | DALL-E 2 | DALL-E 3 | gpt-image-1 |
|---|---|---|---|
| Generate | ✓ | ✓ | ✓ |
| Edit | ✓ | ✗ | ✗ |
| Variation | ✓ | ✗ | ✗ |
| Sprite sheet | ✗ | ✗ | ✓ |
| Max images (n) | 10 | 1 | 1 |
| Style parameter | ✗ | ✓ | ✗ |
| Revised prompt | ✗ | ✓ | ✗ |
| Best for | Variations, bulk | High quality, artistic | Latest capability, sprites |

## Saving Images to Disk

Set `response_format` to `b64_json` and provide an `output_directory` to save generated images as PNG files:

```
Generate a sunset landscape and save it
  → response_format: b64_json, output_directory: /Users/me/Desktop
```

Files are saved as `generated_<timestamp>_<n>.png`, `edited_<timestamp>_<n>.png`, or `variation_<timestamp>_<n>.png`.

## License

MIT
