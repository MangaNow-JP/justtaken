# Media Worker（未実装）

次段階で120秒の閲覧grantを検証し、認可後にのみprivate originalsからGET/HEAD/Rangeを配信する。認可前のcache参照、staging配信、公開r2.dev、認可を迂回するpresigned GETは作らない。現時点ではWorker・バケット・配信URLは存在しない。
