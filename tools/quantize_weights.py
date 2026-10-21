import sys
import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

MIN_ELEMENTS = 2048


def channel_axis(node, input_index):
    if node.op_type in ("Conv", "ConvTranspose") and input_index == 1:
        return 1 if node.op_type == "ConvTranspose" else 0
    if node.op_type == "Gemm" and input_index == 1:
        trans = next((a.i for a in node.attribute if a.name == "transB"), 0)
        return 0 if trans else 1
    if node.op_type == "MatMul" and input_index == 1:
        return 1
    return None


def quantize(model):
    graph = model.graph
    inits = {i.name: i for i in graph.initializer}
    uses = {}
    for node in graph.node:
        for idx, name in enumerate(node.input):
            if name in inits:
                uses.setdefault(name, []).append((node, idx))
    new_nodes = []
    removed = set()
    saved = 0
    for name, refs in uses.items():
        init = inits[name]
        if init.data_type != TensorProto.FLOAT:
            continue
        arr = numpy_helper.to_array(init)
        if arr.size < MIN_ELEMENTS or arr.ndim < 2:
            continue
        axes = {channel_axis(n, i) for n, i in refs}
        if len(axes) != 1 or None in axes:
            continue
        axis = axes.pop()
        reduce_axes = tuple(a for a in range(arr.ndim) if a != axis)
        peak = np.max(np.abs(arr), axis=reduce_axes, keepdims=True)
        scale = np.where(peak > 0, peak / 127.0, 1.0).astype(np.float32)
        q = np.clip(np.round(arr / scale), -127, 127).astype(np.int8)
        scale_vec = scale.reshape(-1)
        q_name, s_name = name + "_q8", name + "_scale"
        graph.initializer.append(numpy_helper.from_array(q, q_name))
        graph.initializer.append(numpy_helper.from_array(scale_vec, s_name))
        new_nodes.append(
            helper.make_node("DequantizeLinear", [q_name, s_name], [name + "_dq"], axis=axis, name=name + "_dequant")
        )
        for node, idx in refs:
            node.input[idx] = name + "_dq"
        removed.add(name)
        saved += arr.nbytes - q.nbytes - scale_vec.nbytes
    keep = [i for i in graph.initializer if i.name not in removed]
    del graph.initializer[:]
    graph.initializer.extend(keep)
    old = list(graph.node)
    del graph.node[:]
    graph.node.extend(new_nodes + old)
    return saved


def main():
    source, target = sys.argv[1], sys.argv[2]
    model = onnx.load(source)
    saved = quantize(model)
    onnx.checker.check_model(model)
    onnx.save(model, target)
    print(f"saved {saved / 1e6:.1f} MB")


main()
