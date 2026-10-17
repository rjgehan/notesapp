package com.rjgehan.notes.support;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * HTTP/1.1 over a plain socket, for what regular clients refuse to do: send a forged {@code Host}, announce a
 * {@code Content-Length} without sending the body, or trickle a body slowly.
 */
public final class RawHttp implements AutoCloseable {

	/** A parsed response; header names are lower case. */
	public record Response(int status, Map<String, String> headers, String body) {
	}

	private final Socket socket;

	private final OutputStream out;

	private final InputStream in;

	public RawHttp(int port, Duration readTimeout) throws IOException {
		this.socket = new Socket();
		this.socket.connect(new InetSocketAddress("127.0.0.1", port), 5000);
		this.socket.setSoTimeout((int) readTimeout.toMillis());
		this.out = this.socket.getOutputStream();
		this.in = this.socket.getInputStream();
	}

	/** Sends a request head (request line and headers, one per line, without the blank line) and nothing else. */
	public void sendHead(String head) throws IOException {
		String crlf = head.strip().replace("\r\n", "\n").replace("\n", "\r\n");
		this.out.write((crlf + "\r\n\r\n").getBytes(StandardCharsets.ISO_8859_1));
		this.out.flush();
	}

	public void sendBody(byte[] bytes) throws IOException {
		this.out.write(bytes);
		this.out.flush();
	}

	/** Reads the final response, skipping interim {@code 1xx} responses such as {@code 100 Continue}. */
	public Response readResponse() throws IOException {
		while (true) {
			String statusLine = readLine();
			int status = Integer.parseInt(statusLine.split(" ")[1]);
			Map<String, String> headers = new LinkedHashMap<>();
			for (String line = readLine(); !line.isEmpty(); line = readLine()) {
				int colon = line.indexOf(':');
				headers.put(line.substring(0, colon).strip().toLowerCase(Locale.ROOT), line.substring(colon + 1).strip());
			}
			if (status >= 100 && status < 200) {
				continue;
			}
			return new Response(status, headers, readBody(headers));
		}
	}

	/** One request on a fresh connection. */
	public static Response exchange(int port, String head) throws IOException {
		try (RawHttp http = new RawHttp(port, Duration.ofSeconds(10))) {
			http.sendHead(head);
			return http.readResponse();
		}
	}

	private String readBody(Map<String, String> headers) throws IOException {
		ByteArrayOutputStream body = new ByteArrayOutputStream();
		if ("chunked".equalsIgnoreCase(headers.get("transfer-encoding"))) {
			while (true) {
				int size = Integer.parseInt(readLine().split(";")[0].strip(), 16);
				if (size == 0) {
					readLine();
					break;
				}
				body.write(this.in.readNBytes(size));
				readLine();
			}
		}
		else if (headers.containsKey("content-length")) {
			body.write(this.in.readNBytes(Integer.parseInt(headers.get("content-length"))));
		}
		return body.toString(StandardCharsets.UTF_8);
	}

	private String readLine() throws IOException {
		ByteArrayOutputStream line = new ByteArrayOutputStream();
		int b;
		while ((b = this.in.read()) != -1) {
			if (b == '\n') {
				break;
			}
			if (b != '\r') {
				line.write(b);
			}
		}
		if (b == -1 && line.size() == 0) {
			throw new IOException("The connection was closed");
		}
		return line.toString(StandardCharsets.ISO_8859_1);
	}

	@Override
	public void close() throws IOException {
		this.socket.close();
	}

}
