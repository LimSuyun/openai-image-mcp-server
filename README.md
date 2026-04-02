# openai-image-mcp-server

An MCP server for OpenAI image generation. Generate, edit, and create variations of images using DALL-E 2, DALL-E 3, and gpt-image-1 — directly from any MCP-compatible client like Claude Desktop, Cursor, or VS Code.

## Tools

| Tool | Description |
|---|---|
| `gpt_image_generate` | Generate images from a text prompt |
| `gpt_image_edit` | Edit an existing image with inpainting/masking |
| `gpt_image_create_variation` | Create stylistic variations of an image (DALL-E 2) |
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
