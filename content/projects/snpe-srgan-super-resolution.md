---
title: "SNPE-SRGAN: Lightweight Super-Resolution on Mobile"
summary: "Compressed SRGAN running on Qualcomm's Snapdragon Neural Processing Engine for on-device super-resolution."
---

**SNPE-SRGAN: Lightweight Generative Adversarial Networks for Single-Image Super-Resolution on Mobile Using SNPE Framework**
International Conference on Computing and Applied Informatics, 2020. With Hendrik Tampubolon and Fanindia Purnamasari.

Low-resolution mobile cameras can't match dedicated HR hardware, and single-image super-resolution (SRGAN) is a strong fix — but running it on-device is expensive. This work converts, quantizes, and compresses an SRGAN model for Qualcomm's Snapdragon Neural Processing Engine (SNPE), validated on the DIV2K dataset across GPU and DSP. The quantized model hit 0.06s latency and a 1.7MB footprint on DSP, versus 9.1MB / 1.6s for the non-quantized TensorFlow baseline.

[Code](https://gitlab.com/aji.setyoko/) · [Published paper](/publications/snpe-srgan/) · [Unofficial paper (PDF)](/files/snpe-srgan-unofficial.pdf)
