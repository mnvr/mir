# Mir User Guide

## What is Mir?

Mir is a new way to interface with large language models. It is currently _work-in-progress_.

## How do I configure settings?

The _Settings_ panel can be opened using the gear icon in the top right of the application window, or the "Settings..." menu option in the Application menu. There is also a keyboard shortcut - `Cmd + ,` (macOS) / `Ctrl + ,` (Windows, Linux).

Note that the Settings panel is shown automatically on app launch until a connection is configured.

## How do I connect Mir to an API?

Open Settings and in the _Connection_ section enter the base API URL (OpenAI `OPENAI_BASE_URL` style). Add the API key if the endpoint requires one.

The base URL should look like

```sh
https://api.openai.com/v1
```

Mir will call the `/chat/completions` path on that base URL. This is the only API endpoint the app currently uses.

Most inference providers, including OpenAI itself, provide support for this so called "Chat completion" endpoint (Anthropic is the notable exception).

## Where is the API key stored?

If secure storage is available on your device, Mir encrypts your key and saves it on your devices' secure storage so that you do not have to re-enter it each time.

If secure storage is not available, Mir keeps your key only for the current session. The key is cleared when the app closes.

## Where is the base URL stored?

The base URL is saved on your device so you do not need to re-enter it.

## What data is sent to the API?

Mir sends the current conversation context to the configured endpoint in a chat-completions format, along with your API key if provided.

## Will my settings sync across devices?

Not yet. Sync is planned and will use end-to-end encryption when it is introduced.

## How do I clear my key?

Delete the API key from the Connection section. If secure storage is available, Mir will remove the saved entry. If not, closing the app also clears it.
