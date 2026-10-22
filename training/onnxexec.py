import numpy as np
import onnx
import torch
import torch.nn.functional as F
from onnx import numpy_helper


def attrs_of(node):
    out = {}
    for a in node.attribute:
        if a.type == onnx.AttributeProto.INT:
            out[a.name] = a.i
        elif a.type == onnx.AttributeProto.INTS:
            out[a.name] = list(a.ints)
        elif a.type == onnx.AttributeProto.FLOAT:
            out[a.name] = a.f
        elif a.type == onnx.AttributeProto.STRING:
            out[a.name] = a.s.decode()
        elif a.type == onnx.AttributeProto.TENSOR:
            out[a.name] = torch.from_numpy(numpy_helper.to_array(a.t).copy())
    return out


def reorder(w, hidden):
    z, r, h = w[:hidden], w[hidden:2 * hidden], w[2 * hidden:]
    return torch.cat([r, z, h], dim=0)


def run_gru(x, w, r, b, h0, hidden):
    w_ih = reorder(w[0], hidden)
    w_hh = reorder(r[0], hidden)
    b_ih = reorder(b[0, :3 * hidden], hidden)
    b_hh = reorder(b[0, 3 * hidden:], hidden)
    hx = h0[:1].contiguous()
    y, hn = torch._VF.gru(x, hx, [w_ih, w_hh, b_ih, b_hh], True, 1, 0.0, True, False, False)
    return y.unsqueeze(1), hn


def onnx_pad(x, pads, value, mode):
    n = x.dim()
    begins = [int(v) for v in pads[:n]]
    ends = [int(v) for v in pads[n:]]
    flat = []
    for i in range(n - 1, -1, -1):
        flat += [begins[i], ends[i]]
    return F.pad(x, flat, mode=mode if mode != 'constant' else 'constant', value=float(value))


def onnx_slice(x, starts, ends, axes, steps):
    for i, ax in enumerate(axes):
        ax = int(ax)
        step = int(steps[i]) if steps is not None else 1
        start, end, step = slice(int(starts[i]), int(ends[i]), step).indices(x.shape[ax])
        idx = torch.arange(start, end, step, dtype=torch.int64)
        x = torch.index_select(x, ax, idx)
    return x


class Graph(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.nodes = list(model.graph.node)
        self.input_names = [i.name for i in model.graph.input if i.name not in {t.name for t in model.graph.initializer}]
        self.output_names = [o.name for o in model.graph.output]
        self.consts = {}
        self.params = torch.nn.ParameterDict()
        self.keys = {}
        self.const_params = {}
        for node in self.nodes:
            if node.op_type != 'Constant':
                continue
            for a in node.attribute:
                if a.name == 'value':
                    arr = numpy_helper.to_array(a.t)
                    if arr.dtype.kind == 'f' and arr.size >= 64:
                        key = 'c%d' % len(self.const_params)
                        self.const_params[node.output[0]] = key
                        self.params[key] = torch.nn.Parameter(torch.from_numpy(arr.astype(np.float32).copy()))
        for init in model.graph.initializer:
            arr = numpy_helper.to_array(init).copy()
            key = 'p%d' % len(self.keys)
            self.keys[init.name] = key
            if arr.dtype.kind == 'f':
                self.params[key] = torch.nn.Parameter(torch.from_numpy(arr.astype(np.float32)))
            else:
                self.consts[init.name] = torch.from_numpy(arr)

    def value(self, env, name):
        if name == '':
            return None
        if name in env:
            return env[name]
        if name in self.keys and self.keys[name] in self.params:
            return self.params[self.keys[name]]
        return self.consts[name]

    def forward(self, *inputs):
        env = dict(zip(self.input_names, inputs))
        for node in self.nodes:
            op = node.op_type
            if op == 'Constant' and node.output[0] in self.const_params:
                env[node.output[0]] = self.params[self.const_params[node.output[0]]]
                continue
            at = attrs_of(node)
            ins = [self.value(env, n) for n in node.input]
            outs = self.execute(op, at, ins)
            for name, val in zip(node.output, outs):
                env[name] = val
        return [env[n] for n in self.output_names]

    def execute(self, op, at, ins):
        if op == 'Constant':
            v = at['value']
            return [v]
        if op == 'ConstantOfShape':
            shape = [int(s) for s in ins[0].tolist()]
            fill = at.get('value', torch.zeros(1))
            return [torch.full(shape, fill.item(), dtype=fill.dtype)]
        if op == 'Shape':
            return [torch.tensor(list(ins[0].shape), dtype=torch.int64)]
        if op == 'Gather':
            axis = at.get('axis', 0)
            idx = ins[1].long()
            if ins[0].dtype == torch.int64 and ins[0].dim() == 1:
                return [ins[0][idx]]
            return [torch.index_select(ins[0], axis, idx.flatten()).reshape(ins[0].shape[:axis] + tuple(idx.shape) + ins[0].shape[axis + 1:])]
        if op == 'Unsqueeze':
            x = ins[0]
            for ax in sorted(at['axes']):
                x = x.unsqueeze(ax)
            return [x]
        if op == 'Squeeze':
            x = ins[0]
            for ax in sorted(at.get('axes', []), reverse=True):
                x = x.squeeze(ax)
            return [x]
        if op == 'Concat':
            axis = at['axis']
            return [torch.cat([i if i.dim() > 0 else i.reshape(1) for i in ins], dim=axis)]
        if op == 'Reshape':
            shape = [int(s) for s in ins[1].tolist()]
            fixed = [ins[0].shape[i] if s == 0 else s for i, s in enumerate(shape)]
            return [ins[0].reshape(fixed)]
        if op == 'Slice':
            steps = ins[4].tolist() if len(ins) > 4 and ins[4] is not None else None
            axes = ins[3].tolist() if len(ins) > 3 and ins[3] is not None else list(range(len(ins[1])))
            return [onnx_slice(ins[0], ins[1].tolist(), ins[2].tolist(), axes, steps)]
        if op == 'Transpose':
            return [ins[0].permute(*at['perm'])]
        if op == 'Cast':
            return [ins[0].to(torch.int64) if at['to'] == 7 else ins[0].to(torch.float32)]
        if op == 'Pad':
            value = ins[2].item() if len(ins) > 2 and ins[2] is not None else 0.0
            return [onnx_pad(ins[0], ins[1].tolist(), value, at.get('mode', 'constant'))]
        if op == 'Conv':
            return [F.conv2d(ins[0], ins[1], ins[2] if len(ins) > 2 else None, stride=at['strides'], padding=(at['pads'][0], at['pads'][1]), dilation=at['dilations'], groups=at['group'])]
        if op == 'ConvTranspose':
            return [F.conv_transpose2d(ins[0], ins[1], ins[2] if len(ins) > 2 else None, stride=at['strides'], padding=(at['pads'][0], at['pads'][1]), output_padding=at.get('output_padding', [0, 0]), groups=at['group'], dilation=at['dilations'])]
        if op == 'Einsum':
            return [torch.einsum(at['equation'], ins[0], ins[1])]
        if op == 'MatMul':
            return [torch.matmul(ins[0], ins[1])]
        if op == 'Add':
            return [ins[0] + ins[1]]
        if op == 'Mul':
            return [ins[0] * ins[1]]
        if op == 'Relu':
            return [F.relu(ins[0])]
        if op == 'Sigmoid':
            return [torch.sigmoid(ins[0])]
        if op == 'Tanh':
            return [torch.tanh(ins[0])]
        if op == 'GRU':
            y, hn = run_gru(ins[0], ins[1], ins[2], ins[3], ins[5], at['hidden_size'])
            return [y, hn]
        raise NotImplementedError(op)

    def patched(self, model):
        patched = onnx.ModelProto()
        patched.CopyFrom(model)
        for node in patched.graph.node:
            if node.op_type == 'Constant' and node.output[0] in self.const_params:
                arr = self.params[self.const_params[node.output[0]]].detach().cpu().numpy().astype(np.float32)
                for a in node.attribute:
                    if a.name == 'value':
                        a.t.CopyFrom(numpy_helper.from_array(arr, a.t.name))
        for init in patched.graph.initializer:
            key = self.keys.get(init.name)
            if key in self.params:
                init.CopyFrom(numpy_helper.from_array(self.params[key].detach().cpu().numpy().astype(np.float32), init.name))
        return patched
