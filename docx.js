(() => {
  "use strict";

  const encoder = new TextEncoder();

  function createFavoritesDocx(favorites) {
    const now = new Date();
    const entries = [
      ["[Content_Types].xml", contentTypesXml()],
      ["_rels/.rels", packageRelationshipsXml()],
      ["docProps/core.xml", corePropertiesXml(now)],
      ["docProps/app.xml", appPropertiesXml()],
      ["word/document.xml", documentXml(favorites)],
      ["word/styles.xml", stylesXml()],
      ["word/_rels/document.xml.rels", documentRelationshipsXml()]
    ].map(([name, text]) => ({ name, data: encoder.encode(text) }));

    return createStoredZip(entries, now);
  }

  function documentXml(favorites) {
    const paragraphs = [
      paragraph("英汉语句收藏", "Title"),
      paragraph(`共 ${favorites.length} 条 · 导出时间 ${formatDate(new Date())}`, "Subtitle")
    ];

    favorites.forEach((favorite, index) => {
      paragraphs.push(paragraph(`收藏 ${index + 1}`, "Heading1"));
      paragraphs.push(...textParagraphs(favorite.english || "（无英文原文）", "QuoteEn"));
      paragraphs.push(...textParagraphs(favorite.chinese || "（未生成中文翻译）", "QuoteZh"));
      if (favorite.url) paragraphs.push(paragraph(`来源：${favorite.url}`, "Meta"));
      if (favorite.savedAt) {
        paragraphs.push(paragraph(`收藏时间：${formatDate(new Date(favorite.savedAt))}`, "Meta"));
      }
    });

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
${paragraphs.join("\n")}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>
</w:body></w:document>`;
  }

  function textParagraphs(text, styleId) {
    return String(text).split(/\r?\n/).map((line) => paragraph(line || " ", styleId));
  }

  function paragraph(text, styleId) {
    return `<w:p><w:pPr><w:pStyle w:val="${styleId}"/></w:pPr><w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
  }

  function stylesXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:eastAsia="Microsoft YaHei"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="330" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Subtitle"/><w:qFormat/><w:pPr><w:spacing w:after="120"/></w:pPr><w:rPr><w:b/><w:color w:val="111827"/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:spacing w:after="360"/></w:pPr><w:rPr><w:color w:val="667085"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="QuoteEn"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="300" w:after="100"/></w:pPr><w:rPr><w:b/><w:color w:val="1D9BF0"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="QuoteEn"><w:name w:val="English Quote"/><w:basedOn w:val="Normal"/><w:next w:val="QuoteZh"/><w:pPr><w:keepNext/><w:ind w:left="240"/><w:spacing w:after="100"/></w:pPr><w:rPr><w:b/><w:color w:val="101828"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="QuoteZh"><w:name w:val="Chinese Quote"/><w:basedOn w:val="Normal"/><w:next w:val="Meta"/><w:pPr><w:ind w:left="240"/><w:spacing w:after="120"/></w:pPr><w:rPr><w:color w:val="344054"/><w:sz w:val="23"/><w:szCs w:val="23"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Meta"><w:name w:val="Metadata"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:ind w:left="240"/><w:spacing w:after="60"/></w:pPr><w:rPr><w:color w:val="667085"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>
</w:styles>`;
  }

  function contentTypesXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
  }

  function packageRelationshipsXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;
  }

  function documentRelationshipsXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  }

  function corePropertiesXml(now) {
    const timestamp = now.toISOString();
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>英汉语句收藏</dc:title><dc:creator>英汉同步阅读扩展</dc:creator><cp:lastModifiedBy>英汉同步阅读扩展</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:modified></cp:coreProperties>`;
  }

  function appPropertiesXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>英汉同步阅读扩展</Application></Properties>`;
  }

  function createStoredZip(entries, timestamp) {
    const localParts = [];
    const centralParts = [];
    const { dosDate, dosTime } = toDosDateTime(timestamp);
    let localOffset = 0;

    for (const entry of entries) {
      const name = encoder.encode(entry.name);
      const crc = crc32(entry.data);
      const localHeader = new Uint8Array(30);
      const localView = new DataView(localHeader.buffer);
      write32(localView, 0, 0x04034b50);
      write16(localView, 4, 20);
      write16(localView, 6, 0x0800);
      write16(localView, 8, 0);
      write16(localView, 10, dosTime);
      write16(localView, 12, dosDate);
      write32(localView, 14, crc);
      write32(localView, 18, entry.data.length);
      write32(localView, 22, entry.data.length);
      write16(localView, 26, name.length);
      const localRecord = concatBytes([localHeader, name, entry.data]);
      localParts.push(localRecord);

      const centralHeader = new Uint8Array(46);
      const centralView = new DataView(centralHeader.buffer);
      write32(centralView, 0, 0x02014b50);
      write16(centralView, 4, 20);
      write16(centralView, 6, 20);
      write16(centralView, 8, 0x0800);
      write16(centralView, 10, 0);
      write16(centralView, 12, dosTime);
      write16(centralView, 14, dosDate);
      write32(centralView, 16, crc);
      write32(centralView, 20, entry.data.length);
      write32(centralView, 24, entry.data.length);
      write16(centralView, 28, name.length);
      write32(centralView, 42, localOffset);
      centralParts.push(concatBytes([centralHeader, name]));
      localOffset += localRecord.length;
    }

    const centralDirectory = concatBytes(centralParts);
    const endRecord = new Uint8Array(22);
    const endView = new DataView(endRecord.buffer);
    write32(endView, 0, 0x06054b50);
    write16(endView, 8, entries.length);
    write16(endView, 10, entries.length);
    write32(endView, 12, centralDirectory.length);
    write32(endView, 16, localOffset);
    return new Blob([...localParts, centralDirectory, endRecord], {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    });
  }

  function concatBytes(parts) {
    const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      output.set(part, offset);
      offset += part.length;
    }
    return output;
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function toDosDateTime(date) {
    const year = Math.max(1980, date.getFullYear());
    return {
      dosDate: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
      dosTime: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)
    };
  }

  function write16(view, offset, value) {
    view.setUint16(offset, value, true);
  }

  function write32(view, offset, value) {
    view.setUint32(offset, value >>> 0, true);
  }

  function xmlEscape(value) {
    return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  }

  function formatDate(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "未知";
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  globalThis.BilingualDocx = Object.freeze({ createFavoritesDocx });
})();
