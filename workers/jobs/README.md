# Jobs（未実装）

次段階でSecurity DOのoutboxをQueues経由でD1へ冪等投影し、固定保存・審査・通知・削除を扱う。event IDとrevisionで重複・逆順・削除後の復活を防ぐ。現時点ではQueue consumerはない。
