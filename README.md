# Kilimanjaro for React Native

React Native clients for Kilimanjaro: query and store your data, run AI inference, and sign users in with Gate.

## Contents

**A. Get started**

1. [Packages](#1-packages)
2. [Install](#2-install)

**B. Reference**

3. [Appendix: links](#3-appendix-links)
   - 3.1 [About Kilimanjaro](#31-about-kilimanjaro)

## A. Get started

### 1. Packages

| Package | Registry name | What it is for |
|---|---|---|
| [`k9o-core`](k9o-core) | `@k9o/core-react-native` | Project client: data, storage, streams and AI |
| [`k9o-gate`](k9o-gate) | `@k9o/gate-react-native` | Gate: sign users in, refresh and sign out; tokens in the platform's secure store |

### 2. Install

```sh
npm install @k9o/core-react-native @k9o/gate-react-native
```

Add only the packages you use. Both come from npm. The Kibo client is in [sdk-kibo-react-native](https://github.com/k9o-platform/sdk-kibo-react-native) and Barbican is in [sdk-barbican-react-native](https://github.com/k9o-platform/sdk-barbican-react-native).
Each package has its own README with a complete example and the expected output.

## B. Reference

### 3. Appendix: links

- Website: <https://kilimanjaro.dev>
- Documentation: <https://docs.kilimanjaro.dev>
- Other SDKs and the CLI: <https://github.com/k9o-platform>
- Issues and discussions: use the tabs of this repository
- License: Apache-2.0

#### 3.1 About Kilimanjaro

Kilimanjaro is a modular developer platform for building secure enterprise applications.
You define AI agents, functions and data pipelines on the platform.
The SDKs let you deploy and invoke them, read and write your data, publish to and subscribe to streams, sign users in, and encrypt with keys you hold.

It provides four building blocks:

- **Keep**: AI security and governance. Guardrails and policy for the agents you run.
- **Pulse**: data intelligence and real-time stream processing. Streams, analytics and live feeds.
- **Gate**: customer identity and access management. Sign-in and sessions, and automatic data scoping so a signed-in user reaches only their own data.
- **Kibo**: cryptographic keys and secrets management. Client-side encryption with keys you hold, and a secrets vault.
