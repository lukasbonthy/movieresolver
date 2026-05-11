const { extractUrlsFromText, parseFoundUrl, repairBrokenProtocol, addHttpsToBareUrl } = require('./extractor');

const encodedSample = `https://filmubox.lemonforest-715663af.southeastasia.azurecontainerapps.io/proxy/video?url=https%3A%2F%2Fbcdnxw.hakunaymatata.com%2Fresource%2Fa74ce4502f7da06879dfd949e3ac7f35.mp4%3Fsign%3De2066826ba1ea7867eeb094fa1bd8365%26t%3D1778457916&apikey=filmu_moviebox_key_v1&referer=https%3A%2F%2Ffmoviesunblocked.net%2F&origin=https%3A%2F%2Ffmoviesunblocked.net`;
const typoSample = encodedSample.replace('https://', 'ttps://');
const bareSample = encodedSample.replace('https://', '');
const rawBrokenSample = `filmubox.lemonforest-715663af.southeastasia.azurecontainerapps.io/proxy/video?url=https://bcdnxw.hakunaymatata.com/resource/a74ce4502f7da06879dfd949e3ac7f35.mp4?sign=4c939e201ce7f47280d2bf4bc705964a&t=1778462447&apikey=filmu_moviebox_key_v1&referer=https://fmoviesunblocked.net/&origin=https://fmoviesunblocked.net`;

for (const sample of [encodedSample, typoSample, bareSample, rawBrokenSample]) {
  const fixed = addHttpsToBareUrl(repairBrokenProtocol(sample));
  const parsed = parseFoundUrl(sample, 'sample');
  const extracted = extractUrlsFromText(`before ${sample} after`, 'sample');

  console.log('INPUT:', sample);
  console.log('FIXED:', fixed);
  console.log(JSON.stringify(parsed, null, 2));

  if (!parsed?.url?.startsWith('https://filmubox.lemonforest-715663af.southeastasia.azurecontainerapps.io/proxy/video?url=')) {
    throw new Error('Did not preserve full proxy URL with https:// prefix');
  }
  if (!parsed?.url?.includes('&apikey=filmu_moviebox_key_v1&referer=')) {
    throw new Error('Did not preserve full query string');
  }
  if (!parsed?.decodedVideoUrl?.includes('https://bcdnxw.hakunaymatata.com/resource/a74ce4502f7da06879dfd949e3ac7f35.mp4?sign=')) {
    throw new Error('Did not decode nested video URL');
  }
  if (!parsed?.encodedProxyUrl?.startsWith('https://filmubox.lemonforest-715663af.southeastasia.azurecontainerapps.io/proxy/video?url=https%3A%2F%2F')) {
    throw new Error('Did not build encoded working proxy URL');
  }
  if (parsed.encodedProxyUrl.includes('url=https://')) {
    throw new Error('Nested url= was not encoded');
  }
  if (!parsed.encodedProxyUrl.includes('%26t%3D')) {
    throw new Error('Nested &t= was not kept inside encoded url=');
  }
  if (!extracted.length) {
    throw new Error('Extractor found 0 results');
  }
}

console.log('All sample URL tests passed.');
