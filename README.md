# Umbrel Apps Gallery

Images for the apps in the [Umbrel App Store](https://apps.umbrel.com), served at `https://getumbrel.github.io/umbrel-apps-gallery/<app-id>/<file>`.

## Generated images

Add an `icon.svg` and the gallery images for an app. A workflow then generates the rest when the change lands on `master`:

- `icon.png`, a 256x256 render of `icon.svg`
- a `.webp` copy of any `.jpg` or `.png` gallery image

Generated files sit next to the originals, and the originals are never changed or removed. To regenerate an app's images, run the "Convert images" workflow manually with the app's folder name.

To run the conversion locally:

```sh
cd .github/scripts && npm ci --ignore-scripts && cd ../..
node .github/scripts/convert.mjs --root . --all
```
