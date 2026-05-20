{
  "targets": [{
    "target_name": "knn",
    "sources": ["src/knn.cpp"],
    "include_dirs": [
      "<!@(node -p \"require('node-addon-api').include\")"
    ],
    "cflags_cc": ["-O3", "-std=c++17", "-fexceptions"],
    "defines": ["NODE_ADDON_API_CPP_EXCEPTIONS"],
    "conditions": [
      ["OS=='mac'", {
        "xcode_settings": {
          "OTHER_CPLUSPLUSFLAGS": ["-O3", "-std=c++17", "-fexceptions"],
          "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
          "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
          "CLANG_CXX_LIBRARY": "libc++"
        }
      }],
      ["OS=='linux' and target_arch=='x64'", {
        "cflags_cc+": ["-march=haswell"]
      }]
    ]
  }]
}
