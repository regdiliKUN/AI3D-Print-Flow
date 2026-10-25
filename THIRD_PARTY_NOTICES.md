# Third-party notices

AI3D Print Flow is a local launcher, configuration console and post-processing helper.
It does not redistribute model weights. Models, node packs and desktop tools are
downloaded from their official sources on first use; each keeps its own license.

## Bundled in this package

| Component | Version / source | License | Notes |
|---|---|---|---|
| PixelArtistry Watertight Meshes installer and workflows | https://github.com/PixelArtistry/PixelArtistry-Watertight-Meshes (MIT) | MIT | `vendor/pixelartistry/`; license text in `vendor/pixelartistry/LICENSE` |
| ComfyUI official Qwen-Image 2.1 template | https://github.com/Comfy-Org/workflow_templates (MIT) | MIT | `vendor/comfy/qwen-image-2.1-t2i.json` |
| ComfyUI official TRELLIS.2 / Pixal3D template | https://github.com/Comfy-Org/workflow_templates (MIT) | MIT | `vendor/comfy/trellis2-native-template.json` |
| Node.js runtime | https://nodejs.org/ (MIT and other licenses) | MIT | `runtime/node.exe`; see https://github.com/nodejs/node/blob/main/LICENSE |

## Downloaded on first use (not included)

| Component | Source | License |
|---|---|---|
| ComfyUI Easy Install | https://github.com/Tavris1/ComfyUI-Easy-Install | MIT |
| ComfyUI | https://github.com/comfyanonymous/ComfyUI | GPL-3.0 |
| ComfyUI-Trellis2 (visualbruno) | https://github.com/visualbruno/ComfyUI-Trellis2 | See repository |
| WTiVo Watertight Voxel | https://github.com/Mstafa-awad/WTiVo-WatertightVoxel-ComfyuiNode | GPL-3.0 (check repository) |
| Mesh Quad Reconstruct | https://github.com/Mstafa-awad/ComfyUI-Mesh-Quad-Reconstruct | See repository |
| LODTailor Mesh Trimmer | https://github.com/Mstafa-awad/LODTailor-The-Mesh-Trimmer-ComfyuiNode | See repository |
| WTiVo Fast Merge by Distance | https://github.com/Mstafa-awad/WTiVo-FastMergeByDistance | See repository |
| ComfyUI Memory Cleaner | https://github.com/Mstafa-awad/ComfyUI-Memory-Cleaner | See repository |
| CuMesh Decimate | https://github.com/Mstafa-awad/ComfyUI-CuMesh-Decimate | See repository |
| TRELLIS.2 models | https://huggingface.co/Comfy-Org/TRELLIS.2 | Check model card |
| Pixal3D models | https://huggingface.co/Comfy-Org/Pixal3D | Check model card |
| Qwen-Image 2.1 models | https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI | Check model card |
| Blender | https://www.blender.org/download/ | GPL-2.0-or-later |
| CHITUBOX | https://www.chitubox.com/ | Proprietary freeware |

If you use generated models commercially, check the license of every node pack,
model and tool in your own chain. The MIT license of this wrapper does not grant
rights to third-party components.
