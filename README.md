# Gemini OAuth Plugin for Opencode

Plugin for Opencode that allows you to authenticate with your Google account. This allows you to use your Google account instead of using the API.

## Setup

### 1. Install

Add the `opencode-gemini-auth` plugin to your [opencode config](https://opencode.ai/docs/config/)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-gemini-auth"]
}
```

### 2. Login with opencode

```shell
opencode auth login
```

### 3. Select Google

Select the Google provider and select "OAuth with Google (Gemini)" then follow the instructions.
