# Social Media Image Generation Guide

## Tool: Pollinations.ai (Free, No API Key)

**Base URL:** `https://image.pollinations.ai/prompt/{encoded_prompt}`

**Parameters:**
- `width` — Image width (default: 1200)
- `height` — Image height (default: 675 for X, 627 for LinkedIn)
- `seed` — Reproducibility (-1 for random)
- `nologo` — Remove watermark (true)

## Brand Style Prompt Prefix

Every image prompt MUST start with:

> professional flat isometric illustration, navy blue and teal color scheme, clean modern data-driven aesthetic, no human faces, no text overlay, minimal design

## Post-Type Prompt Templates

### SEO / Website Audit
`{prefix}, website audit dashboard with SEO score charts and metrics`

### Broken Links
`{prefix}, broken chain links scattered across a web page layout`

### Page Speed
`{prefix}, speedometer gauge showing website loading performance`

### Mobile Optimization
`{prefix}, responsive website displayed on phone tablet and desktop screens`

### Security / SSL
`{prefix}, shield icon protecting a website with lock symbols`

### Analytics / Data
`{prefix}, data analytics dashboard with bar charts and trend lines`

### Content Strategy
`{prefix}, content calendar with blog posts and social media icons`

### Technical SEO
`{prefix}, website sitemap structure with connected nodes and crawl paths`

## Image Dimensions

| Platform | Width | Height | Aspect Ratio |
|----------|-------|--------|-------------|
| X/Twitter | 1200 | 675 | 16:9 |
| LinkedIn | 1200 | 627 | 1.91:1 |

## Usage in Posting Workflow

1. Match post topic to nearest template above
2. Generate image via URL or `scripts/generate-social-image.sh`
3. Download image to temp file
4. Upload via platform media API before posting
5. Include media_id in post payload

## Example

```bash
# Generate an image for a broken links post
./scripts/generate-social-image.sh "broken chain links scattered across a web page layout"
```
