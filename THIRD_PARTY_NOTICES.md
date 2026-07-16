# Third-party notices

VOIVOX includes or bundles the following open-source components. Their licenses remain with their respective copyright holders.

- [Transformers.js](https://github.com/huggingface/transformers.js), Apache License 2.0.
- [`@huggingface/jinja`](https://github.com/huggingface/huggingface.js/tree/main/packages/jinja), MIT License, Copyright (c) 2023 Hugging Face.
- [ONNX Runtime Web](https://github.com/microsoft/onnxruntime), MIT License, Copyright Microsoft Corporation.
- [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), MIT License.
- [Ajv](https://github.com/ajv-validator/ajv), [ajv-formats](https://github.com/ajv-validator/ajv-formats), [fast-deep-equal](https://github.com/epoberezkin/fast-deep-equal), and [json-schema-traverse](https://github.com/epoberezkin/json-schema-traverse), MIT License.
- [fast-uri](https://github.com/fastify/fast-uri), BSD 3-Clause License.
- [Zod](https://github.com/colinhacks/zod), MIT License, and [zod-to-json-schema](https://github.com/StefanTerdell/zod-to-json-schema), ISC License.
- [React and React DOM](https://github.com/facebook/react), MIT License.
- [Electron](https://github.com/electron/electron), MIT License.

The Chrome extension downloads pinned ONNX conversions of `openai/whisper-tiny` or `openai/whisper-base` on first use. Those model files are not redistributed in this repository or its release archives. See the linked [tiny](https://huggingface.co/onnx-community/whisper-tiny) and [base](https://huggingface.co/onnx-community/whisper-base) model cards before use.

The optional desktop-ASR installer separately downloads [`mlx-qwen3-asr`](https://pypi.org/project/mlx-qwen3-asr/) and [`Qwen/Qwen3-ASR-0.6B`](https://huggingface.co/Qwen/Qwen3-ASR-0.6B), both published under the Apache License 2.0 at the time of this release. Neither the Python package nor the model weights are distributed in the VOIVOX repository or release archives; users should review the linked current terms before installing them.

Each release archive includes the VOIVOX MIT license. The extension also includes the complete Transformers.js, `@huggingface/jinja`, and ONNX Runtime license texts. The App resources include the complete license texts for its bundled MCP dependency graph, React/React DOM, Electron, Transformers.js, and ONNX Runtime. `ELECTRON_CHROMIUM_NOTICES.html` in the App resources contains the Chromium and other third-party notices distributed with Electron.
