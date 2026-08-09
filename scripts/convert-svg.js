const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const svgDir = path.join(__dirname, '..', 'assets', 'svg');
const outputDir = path.join(__dirname, '..', 'assets');

if (!fs.existsSync(svgDir)) {
  console.error(`SVG source directory not found: ${svgDir}`);
  process.exit(1);
}

const files = fs.readdirSync(svgDir).filter((file) => file.endsWith('.svg'));

files.forEach((file) => {
  const svgPath = path.join(svgDir, file);
  const pngName = file.replace(/\.svg$/, '.png');
  const pngPath = path.join(outputDir, pngName);

  const svgContent = fs.readFileSync(svgPath, 'utf8');
  const resvg = new Resvg(svgContent, {
    fitTo: {
      mode: 'zoom',
      value: 2,
    },
    font: {
      loadSystemFonts: true,
      defaultFontFamily: 'Segoe UI',
    },
  });

  const pngData = resvg.render();
  const pngBuffer = pngData.asPng();

  fs.writeFileSync(pngPath, pngBuffer);
  console.log(`Converted ${file} -> ${pngName}`);
});
