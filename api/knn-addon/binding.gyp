{
  "targets": [{
    "target_name": "knn",
    "sources": ["src/knn.cpp"],
    "include_dirs": [
      "<!@(node -p \"require('node-addon-api').include\")"
    ],
    "cflags_cc": ["-O3", "-march=haswell", "-std=c++17"],
    "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"]
  }]
}
