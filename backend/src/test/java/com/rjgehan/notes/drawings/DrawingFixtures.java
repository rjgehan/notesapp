package com.rjgehan.notes.drawings;

/** Drawing files for the tests, as excalidraw.com and the Obsidian Excalidraw plugin write them. */
final class DrawingFixtures {

	private DrawingFixtures() {
	}

	/** An {@code .excalidraw} file with these elements (JSON objects) and {@code files} entries. */
	static String excalidraw(String files, String... elements) {
		return "{\n  \"type\": \"excalidraw\",\n  \"version\": 2,\n  \"source\": \"https://excalidraw.com\",\n"
				+ "  \"elements\": [\n    " + String.join(",\n    ", elements) + "\n  ],\n"
				+ "  \"appState\": {\"gridSize\": 20, \"viewBackgroundColor\": \"#ffffff\"},\n  \"files\": " + files
				+ "\n}\n";
	}

	static String element(String id, String type, String extra) {
		return "{\"id\": \"" + id + "\", \"type\": \"" + type + "\", \"x\": 0, \"y\": 0, \"width\": 100, \"height\": 40, "
				+ "\"strokeColor\": \"#1e1e1e\", \"version\": 3, \"versionNonce\": 77, \"isDeleted\": false"
				+ (extra.isEmpty() ? "" : ", " + extra) + "}";
	}

	static final String PLUGIN_HEAD = """
			---

			excalidraw-plugin: parsed
			tags: [excalidraw]

			---
			==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== You can decompress Drawing \
			data with the command palette: 'Decompress current Excalidraw file'. For more info check in plugin \
			settings under 'Saving'


			# Excalidraw Data

			""";

	/**
	 * The plugin's Markdown around {@link #PLUGIN_BLOCK}: two of its text elements under Text Elements (one whose
	 * text holds its own link), and one element link under Element Links.
	 */
	static final String PLUGIN_SECTIONS = """
			## Text Elements
			Hello [[World]] ^Ab12Cd34

			See [[Synced]] ^Tt33Uu44

			## Element Links
			Rr11Ss22: [[Covered]]

			""";

	/**
	 * lz-string 1.5.0's {@code compressToBase64} of a scene, in the plugin's 256-character chunks: the texts
	 * {@code Ab12Cd34} "Hello [[World]]", {@code Zz99Yy88} "Orphan text [[Orphan]] #drawn" (in no Text Elements
	 * entry), {@code Tt33Uu44} "See [[Synced]]" with the link {@code [[Synced]]}, and the deleted {@code Dd55Ee66}
	 * "Gone [[Deleted]]"; the rectangles {@code rect-0123456789abcdefg} linking {@code [[Linked]]} (in no Element Links
	 * line) and {@code Rr11Ss22} linking {@code [[Covered]]}; and a frame named "Plan frame".
	 */
	static final String PLUGIN_BLOCK = """
			N4KAkARALgngDgUwgLgAQQQDwMYEMA2AlgCYBOuA7hADTgQBuCpAzoQPYB2KqATLZMzYBXUtiRoIACyhQ4zZAHoFAc0JRJQgEYA6bGwC2CgF7N6hbEcK4OCtptbErHALRY8RMpWdx8Q1V34MfAR9BA4oZm4AbXAwUDAEiExuAAZ+RJhU9MgKEnVuAEYUtNjISQRCZWluABYShMhrZWCs0ohmKFI2AGsEAGE2fDZSbggAYgKEScmaNs1cbG7lLqEO

			YgGhkYlO62Y4XFIwqFmGhiZWTkLss5Z2DgA5TjFuAHZrwmYAEQRgqARibgAMwIzAQ7wBEgAgpoCjw+sQAMw1E6JWCIUZ/TDHa6Y44SAASPyGqAA6sN8ADruQKAAVLB49CE/DEqJRMmkCkAXU5KMgw0qhA4BDpWNGTOJ7IpEFiAF90vFEsk0PUMq1TrliPk0EUVWUKlUGXVrk0Wsrrh0ur0NsNRhMpvbeRB5otlsI1tatugdhw9gcjo7GLdLtrroG

			Lg8nuJUG82h9vr9/kCQWDYxD0AAtIwATizAE0YAAOAuOtFR6D0ksViQAeVIcEk1lQuNQtfrjbGngoATa1JFDIgrYbHCb9NQrMH1m5qA71O7p35/mFVfQE+HzdX087XFl8raStQuogmTNbQ1WtQOuu5Uq1TQRraJqjh4tPX6gxtEjt0yQ12dSxW7rvp60DkD6+yHOEAbnHcVxtGGdyPBwzxoDGpxxj8CB/GmwL4KC4KjIc2BQM4KSwkiACsABsLwF

			lmuCaNgxAIICyglvAZaEVAj6OkQHDdKMrIADKCr0xDctKCRyrECqQPuh7Hge1xnpIhTFFe+q3qg96nNxJ6nC+VpAba34zL+Cz/m66xGdsoG+hB2JwdBwYXqGTkRkhUaoYk6EJthyb4RIABKpAFAUADKzA8DwbHohInHcdcvH8RIrIDIG/ziTu0l7mqqp6YkymqYe14GrUh66YpbQGW+mzGfaplzOZrqrFZtU2bs4H+q5QZcCGjk9YhyHRu8XwYVh

			Sa4SmaFphANJQAiCIAKpCDUyI4uxGIVjiy4QGFCAIKgYUwB5lI9pQfajHtB2skdJ3idcC6CkuooSFdh3HWIp2nElAlRLdn2ZZJu6nHJ1wKYehXampbQlZp2mJBVz6dK+Hp1d+jp/s1gFtV6tmdZB3XhrBpzwZwg2eSN8aYYmaCdEIU3eTNnzEOR5EAKIIJRlExWWuKVi96AAOKcD+Z20jtwscNdURU1h91tI9Qr4BdEiS0gWUJDJSS5ZA4NKXkKl

			Q8VGmGuVHDNE+5rI4ZOPjCZounJjAGtR+uMdX6BP9UTfUk255OvJTY006gOF4amoyAuQoTOPRjHMVUhAAFbdPg+gcGwcA8xHUcO4kQqhKMAAK+CNpHuAF7K4CcoEuBwHAYVcX83AKhAywkGFhBGFGHBCMy6QMIQCAUAAQk1zuo5+gJT9PElSZAgKEMEkRoMAMogDKQA=
			""";

	/** The plugin's file: frontmatter, its warning, the Markdown sections and the %%-wrapped compressed drawing. */
	static final String PLUGIN_FILE = PLUGIN_HEAD + PLUGIN_SECTIONS + "%%\n## Drawing\n```compressed-json\n"
			+ PLUGIN_BLOCK + "```\n%%";

}
