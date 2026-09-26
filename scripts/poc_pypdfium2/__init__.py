"""pdfplumberからpypdfium2への移行 効果測定PoC(ADR 0032)。

既存の `src/pdf_unit/` は変更しない。ここに置く代替実装は、既存関数(`extract_page_lines`・
`extract_page_texts`・`_render_page`)と比較するための試作であり、本番コードからは参照されない。
"""
