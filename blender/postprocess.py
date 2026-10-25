"""
AI3D Print Flow · Blender 后处理脚本
用法：
  blender --background --factory-startup --python postprocess.py -- \
    --input model.glb --output model.stl --report report.json \
    --target-height 80 --repair auto --decimate 0 --keep-largest 1

设计原则：
- 不改动源文件；所有操作在 Blender 内完成。
- 默认只做视频里演示的清理：合并、焊点、删除碎块、重算法线、导出 STL。
- 只有检测到非水密且 repair != none 时才做补洞/体素重建，避免无谓损失细节。
"""
import bpy
import bmesh
import json
import math
import os
import sys
import traceback
from datetime import datetime
from mathutils import Vector


def parse_args():
    argv = sys.argv
    args = argv[argv.index("--") + 1:] if "--" in argv else []
    out = {
        "input": "",
        "output": "",
        "report": "",
        "target_height": 0.0,
        "repair": "auto",
        "decimate": 0.0,
        "keep_largest": True,
        "voxel_size": 0.0,
    }
    i = 0
    while i < len(args):
        key = args[i]
        val = args[i + 1] if i + 1 < len(args) else ""
        if key == "--input":
            out["input"] = val
        elif key == "--output":
            out["output"] = val
        elif key == "--report":
            out["report"] = val
        elif key == "--target-height":
            out["target_height"] = float(val or 0)
        elif key == "--repair":
            out["repair"] = val or "auto"
        elif key == "--decimate":
            out["decimate"] = float(val or 0)
        elif key == "--keep-largest":
            out["keep_largest"] = val not in ("0", "false", "False")
        elif key == "--voxel-size":
            out["voxel_size"] = float(val or 0)
        i += 2
    return out


def log(msg):
    print(f"[AI3D] {msg}", flush=True)


def progress(pct, message):
    """Structured progress marker.

    The console used to guess progress by substring-matching Chinese log lines,
    which silently stalled whenever the wording changed. A dedicated marker
    keeps the progress bar tied to real pipeline stages.
    """
    print(f"[AI3D] PROGRESS {int(pct)} {message}", flush=True)


def write_report(path, payload):
    if not path:
        return
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
    except Exception as exc:
        log(f"写入报告失败：{exc}")


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.images):
        for item in list(block):
            if item.users == 0:
                block.remove(item)


def import_glb(path):
    kwargs = {"filepath": path}
    try:
        bpy.ops.import_scene.gltf(**kwargs, merge_vertices=True)
    except TypeError:
        bpy.ops.import_scene.gltf(**kwargs)
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not meshes:
        raise RuntimeError("GLB 中没有网格对象")
    return meshes


def join_meshes(meshes):
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes:
        o.select_set(True)
    # 用面数最多的对象作为合并目标，避免最终原点落在碎块上。
    meshes = sorted(meshes, key=lambda o: len(o.data.polygons), reverse=True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return obj


def keep_components(obj, keep_largest, min_ratio=0.01, min_faces=24):
    """按松散块分离，删除碎屑；keep_largest=True 时保留主块及占比 >=1% 的独立部件。"""
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.separate(type="LOOSE")
    bpy.ops.object.mode_set(mode="OBJECT")

    parts = [o for o in bpy.context.selected_objects if o.type == "MESH"]
    if len(parts) <= 1:
        return obj, {"separated": len(parts), "removed": 0, "kept": len(parts)}

    parts.sort(key=lambda o: len(o.data.polygons), reverse=True)
    max_faces = len(parts[0].data.polygons)
    threshold = max(min_faces, int(max_faces * min_ratio))
    if keep_largest:
        keep = [p for p in parts if len(p.data.polygons) >= threshold]
        if not keep:
            keep = [parts[0]]
    else:
        keep = list(parts)

    removed_parts = [p for p in parts if p not in keep]
    if removed_parts:
        bpy.ops.object.select_all(action="DESELECT")
        for part in removed_parts:
            part.select_set(True)
        bpy.context.view_layer.objects.active = removed_parts[0]
        bpy.ops.object.delete(use_global=False)

    keep = [o for o in keep if o.name in bpy.data.objects]
    bpy.ops.object.select_all(action="DESELECT")
    for part in keep:
        part.select_set(True)
    bpy.context.view_layer.objects.active = keep[0]
    if len(keep) > 1:
        bpy.ops.object.join()
    return bpy.context.view_layer.objects.active, {
        "separated": len(parts),
        "removed": len(removed_parts),
        "kept": len(keep),
        "thresholdFaces": threshold if keep_largest else 0,
    }


def mesh_stats(obj):
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.edges.ensure_lookup_table()
    boundary = 0
    non_manifold = 0
    for e in bm.edges:
        n = len(e.link_faces)
        if n == 1:
            boundary += 1
        elif n > 2:
            non_manifold += 1
    loose_verts = sum(1 for v in bm.verts if not v.link_faces)
    volume = abs(bm.calc_volume(signed=True)) if bm.faces else 0.0
    bm.free()
    dims = tuple(obj.dimensions)
    # 键名不带单位：导入后场景单位是 GLB 自带的（通常为米），只有缩放到
    # 目标毫米之后场景单位才等于毫米。原来的 `volumeMm3` / `dimensionsMm`
    # 在 before 阶段会把 0.2 m 的立方体写成「0.2 mm / 0.01 mm³」，误差 9 个数量级。
    return {
        "vertices": len(me.vertices),
        "triangles": len(me.polygons),
        "boundaryEdges": boundary,
        "nonManifoldEdges": non_manifold,
        "looseVertices": loose_verts,
        "watertight": boundary == 0 and non_manifold == 0,
        "volumeUnits3": round(volume, 2),
        "dimensionsUnits": [round(float(v), 3) for v in dims],
    }


def weld_and_normals(obj, dist=1e-5):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=dist)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()


def fill_small_holes(obj, max_edges=200000):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    boundary = [e for e in bm.edges if len(e.link_faces) == 1]
    if not boundary:
        bm.free()
        return 0
    if len(boundary) > max_edges:
        bm.free()
        return -1
    try:
        bmesh.ops.holes_fill(bm, edges=boundary, sides=0)
        bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
        bm.to_mesh(obj.data)
        obj.data.update()
    except Exception as exc:
        log(f"补洞失败：{exc}")
        bm.free()
        return -1
    bm.free()
    return len(boundary)


def voxel_remesh(obj, voxel_size):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    obj.data.remesh_voxel_size = max(0.001, voxel_size)
    try:
        obj.data.remesh_voxel_adaptivity = 0.0
    except Exception:
        pass
    bpy.ops.object.voxel_remesh()
    return mesh_stats(obj)


def decimate(obj, ratio):
    if ratio <= 0 or ratio >= 1:
        return
    mod = obj.modifiers.new(name="AI3D_Decimate", type="DECIMATE")
    mod.ratio = ratio
    mod.use_collapse_triangulate = True
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=mod.name)


def scale_to_height(obj, target_mm):
    if target_mm <= 0:
        return 1.0
    dims = obj.dimensions
    current = max(dims.x, dims.y, dims.z)
    if current <= 1e-9:
        return 1.0
    # 对雕像类模型按 Z 高度缩放；若 Z 明显不是主方向，则按最大边。
    base = dims.z if dims.z > max(dims.x, dims.y) * 0.35 else current
    factor = target_mm / base
    obj.scale = (factor, factor, factor)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return factor


def center_on_bed(obj):
    """把模型 XY 居中、Z 最低点放到 0，方便切片软件直接摆放。"""
    bpy.context.view_layer.update()
    corners = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
    if not corners:
        return
    xs = [c.x for c in corners]
    ys = [c.y for c in corners]
    zs = [c.z for c in corners]
    obj.location.x -= (min(xs) + max(xs)) / 2.0
    obj.location.y -= (min(ys) + max(ys)) / 2.0
    obj.location.z -= min(zs)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)


def export_stl(obj, path):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    os.makedirs(os.path.dirname(path), exist_ok=True)
    try:
        bpy.ops.wm.stl_export(
            filepath=path,
            export_selected_objects=True,
            global_scale=1.0,
            apply_modifiers=True,
            ascii_format=False,
        )
    except Exception:
        bpy.ops.export_mesh.stl(
            filepath=path,
            use_selection=True,
            global_scale=1.0,
            ascii=False,
        )


def main():
    opt = parse_args()
    try:
        run(opt)
    except Exception as exc:
        # A failed run used to leave no artefact at all, so the console could
        # only show a truncated stderr tail. Persist a machine-readable report
        # next to where the success report would have gone.
        write_report(
            opt.get("report"),
            {
                "ok": False,
                "generatedAt": datetime.now().isoformat(timespec="seconds"),
                "blender": bpy.app.version_string,
                "input": opt.get("input", ""),
                "output": opt.get("output", ""),
                "parameters": {
                    "targetHeightMm": opt.get("target_height", 0),
                    "repair": opt.get("repair", "auto"),
                    "decimate": opt.get("decimate", 0),
                    "keepLargest": opt.get("keep_largest", True),
                },
                "error": str(exc),
                "traceback": traceback.format_exc(),
            },
        )
        raise


def run(opt):
    if not opt["input"] or not os.path.exists(opt["input"]):
        raise RuntimeError(f"输入不存在：{opt['input']}")
    if not opt["output"]:
        raise RuntimeError("缺少 --output")

    log(f"Blender {bpy.app.version_string}")
    log(f"输入：{opt['input']}")
    progress(5, "读取 GLB…")
    clear_scene()
    meshes = import_glb(opt["input"])
    total_faces = sum(len(o.data.polygons) for o in meshes)
    log(f"导入 {len(meshes)} 个网格对象")
    if total_faces == 0:
        raise RuntimeError("GLB 里没有可打印的面（0 个多边形）。请回到 ComfyUI 检查水密工作流的输出。")
    progress(15, f"已导入 {len(meshes)} 个网格")

    obj = join_meshes(meshes)
    bpy.ops.object.mode_set(mode="OBJECT")
    progress(22, "合并网格…")

    before = mesh_stats(obj)
    log(f"导入后：{before['vertices']} 顶点 / {before['triangles']} 三角面 / 边界边 {before['boundaryEdges']}")

    weld_and_normals(obj)
    progress(26, "焊接顶点、重算法线…")
    obj, comp = keep_components(obj, opt["keep_largest"])
    log(f"松散块：分离 {comp.get('separated')}，删除 {comp.get('removed')}，保留 {comp.get('kept', 1)}")
    progress(34, f"删除碎块（保留 {comp.get('kept', 1)} 块）")

    stats = mesh_stats(obj)
    repaired = None
    progress(40, "检查水密性…")
    if not stats["watertight"] and opt["repair"] != "none":
        filled = fill_small_holes(obj) if opt["repair"] in ("auto", "fill", "voxel") else -1
        if filled > 0:
            repaired = f"holes_fill({filled})"
            log(f"补洞：处理 {filled} 条边界边")
        progress(48, "补小洞…")
        stats = mesh_stats(obj)
        if not stats["watertight"] and opt["repair"] in ("auto", "voxel"):
            h = max(obj.dimensions.z, obj.dimensions.x, obj.dimensions.y)
            # 体素边长必须是模型自身尺度的比例；GLB 通常以米为单位。
            # 之前用固定 0.08 会把 0.2 m 高的模型直接抹平。
            voxel = opt["voxel_size"] or max(h / 300.0, 1e-6)
            log(f"体素重建：voxel_size={voxel:.6f}")
            progress(58, "体素重建（较慢，请耐心等待）…")
            stats = voxel_remesh(obj, voxel)
            repaired = (repaired + "+" if repaired else "") + f"voxel({voxel:.4f})"
            stats = mesh_stats(obj)

    progress(72, "缩放到目标尺寸…")
    factor = scale_to_height(obj, opt["target_height"])
    if factor != 1.0:
        log(f"缩放系数：{factor:.6f} → 目标高度 {opt['target_height']} mm")
    progress(80, "居中到平台…")
    center_on_bed(obj)

    if opt["decimate"] and opt["decimate"] < 1:
        progress(86, "减面…")
        decimate(obj, opt["decimate"])
        log(f"减面：ratio={opt['decimate']}")

    final = mesh_stats(obj)
    progress(90, "导出 STL…")
    export_stl(obj, opt["output"])

    bbox_volume = final["dimensionsUnits"][0] * final["dimensionsUnits"][1] * final["dimensionsUnits"][2]
    voxel_shell_warning = bool(
        repaired
        and "voxel" in repaired
        and bbox_volume > 0
        and final["volumeUnits3"] < bbox_volume * 0.02
    )
    if voxel_shell_warning:
        log("警告：体素重建后的体积接近 0，可能生成薄壳；请在切片软件中检查实体厚度。")

    # 缩放之后场景单位就是毫米；只有明确设置了目标高度才敢这么断言，
    # 否则保留中性键名，避免把「米」当成「毫米」。
    scaled = dict(final)
    if opt["target_height"] > 0:
        scaled["units"] = "mm"
        scaled["dimensionsMm"] = final["dimensionsUnits"]
        scaled["volumeMm3"] = final["volumeUnits3"]
    else:
        scaled["units"] = "scene"

    report = {
        "ok": True,
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "blender": bpy.app.version_string,
        "input": opt["input"],
        "output": opt["output"],
        "parameters": {
            "targetHeightMm": opt["target_height"],
            "repair": opt["repair"],
            "decimate": opt["decimate"],
            "keepLargest": opt["keep_largest"],
        },
        "before": {**before, "units": "scene", "unitsNote": "导入时的场景单位（GLB 通常为米）"},
        "components": comp,
        "repaired": repaired,
        "scaleFactor": round(factor, 8),
        "final": scaled,
        "voxelShellWarning": voxel_shell_warning,
    }
    write_report(opt["report"], report)
    log("AI3D_REPORT " + json.dumps(report, ensure_ascii=False))
    # 94, not 100: the console still runs its own STL verification afterwards.
    progress(94, "导出完成")
    log(f"已导出：{opt['output']}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"[AI3D] 失败：{exc}", flush=True)
        traceback.print_exc()
        sys.exit(1)
