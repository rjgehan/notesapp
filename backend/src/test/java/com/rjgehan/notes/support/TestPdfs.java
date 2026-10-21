package com.rjgehan.notes.support;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.UncheckedIOException;

import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDPageContentStream;
import org.apache.pdfbox.pdmodel.font.PDType1Font;
import org.apache.pdfbox.pdmodel.font.Standard14Fonts;

/** Small PDFs with real text, written with PDFBox, for extraction tests. */
public final class TestPdfs {

	private TestPdfs() {
	}

	/** A PDF with one page per argument; lines of a page are separated by {@code \n}. */
	public static byte[] withPages(String... pages) {
		try (PDDocument document = new PDDocument()) {
			PDType1Font font = new PDType1Font(Standard14Fonts.FontName.HELVETICA);
			for (String text : pages) {
				PDPage page = new PDPage();
				document.addPage(page);
				try (PDPageContentStream content = new PDPageContentStream(document, page)) {
					content.beginText();
					content.setFont(font, 12);
					content.newLineAtOffset(72, 700);
					for (String line : text.split("\n")) {
						content.showText(line);
						content.newLineAtOffset(0, -16);
					}
					content.endText();
				}
			}
			ByteArrayOutputStream out = new ByteArrayOutputStream();
			document.save(out);
			return out.toByteArray();
		}
		catch (IOException ex) {
			throw new UncheckedIOException(ex);
		}
	}

}
