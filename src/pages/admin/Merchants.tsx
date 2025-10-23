import { useEffect, useState } from "react";
import { listMerchants, updateMerchant } from "@/lib/adminApi";
import { Merchant } from "@/types/admin";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { Search } from "lucide-react";

export default function Merchants() {
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selectedMerchant, setSelectedMerchant] = useState<Merchant | null>(null);

  const fetchMerchants = async () => {
    setLoading(true);
    const res = await listMerchants({ q: search });
    if (res.ok) {
      setMerchants(res.items);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchMerchants();
  }, [search]);

  const handleToggleEnabled = async (merchant: Merchant) => {
    const newEnabled = !merchant.enabled;
    await updateMerchant(merchant.uid, { enabled: newEnabled });
    toast.success(
      `${merchant.storeName} ${newEnabled ? "enabled" : "disabled"} successfully.`
    );
    fetchMerchants();
  };

  return (
    <div className="space-y-4">
      {/* Search */}
      <Card>
        <CardContent className="pt-6">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by name, email, or store..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
        </CardContent>
      </Card>

      {/* Merchants Table */}
      <Card>
        <CardContent className="pt-6">
          {loading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Store</TableHead>
                  <TableHead>Enabled</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {merchants.map((merchant) => (
                  <TableRow
                    key={merchant.uid}
                    className="cursor-pointer"
                    onClick={() => setSelectedMerchant(merchant)}
                  >
                    <TableCell className="font-medium">{merchant.name}</TableCell>
                    <TableCell>{merchant.email}</TableCell>
                    <TableCell>{merchant.phone}</TableCell>
                    <TableCell>{merchant.storeName}</TableCell>
                    <TableCell>
                      <Switch
                        checked={merchant.enabled}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleToggleEnabled(merchant);
                        }}
                      />
                    </TableCell>
                    <TableCell>
                      {merchant.createdAt
                        ? new Date(merchant.createdAt).toLocaleDateString()
                        : "-"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Merchant Details Sheet */}
      <Sheet
        open={!!selectedMerchant}
        onOpenChange={() => setSelectedMerchant(null)}
      >
        <SheetContent className="overflow-y-auto">
          {selectedMerchant && (
            <>
              <SheetHeader>
                <SheetTitle>{selectedMerchant.storeName}</SheetTitle>
                <SheetDescription>Merchant Profile Details</SheetDescription>
              </SheetHeader>

              <div className="mt-6 space-y-4">
                <div className="flex justify-between items-center">
                  <span className="font-semibold">Status:</span>
                  <Badge variant={selectedMerchant.enabled ? "default" : "secondary"}>
                    {selectedMerchant.enabled ? "Enabled" : "Disabled"}
                  </Badge>
                </div>

                <div>
                  <span className="font-semibold block mb-1">Owner Name:</span>
                  <p className="text-sm text-muted-foreground">
                    {selectedMerchant.name}
                  </p>
                </div>

                <div>
                  <span className="font-semibold block mb-1">Email:</span>
                  <p className="text-sm text-muted-foreground">
                    {selectedMerchant.email}
                  </p>
                </div>

                <div>
                  <span className="font-semibold block mb-1">Phone:</span>
                  <p className="text-sm text-muted-foreground">
                    {selectedMerchant.phone}
                  </p>
                </div>

                <div>
                  <span className="font-semibold block mb-1">Business Category:</span>
                  <p className="text-sm text-muted-foreground">
                    {selectedMerchant.businessCategory}
                  </p>
                </div>

                {selectedMerchant.gstin && (
                  <div>
                    <span className="font-semibold block mb-1">GSTIN:</span>
                    <p className="text-sm text-muted-foreground">
                      {selectedMerchant.gstin}
                    </p>
                  </div>
                )}

                {selectedMerchant.address && (
                  <div>
                    <span className="font-semibold block mb-1">Address:</span>
                    <p className="text-sm text-muted-foreground">
                      {selectedMerchant.address}
                    </p>
                  </div>
                )}

                <div>
                  <span className="font-semibold block mb-1">Joined:</span>
                  <p className="text-sm text-muted-foreground">
                    {selectedMerchant.createdAt
                      ? new Date(selectedMerchant.createdAt).toLocaleDateString()
                      : "-"}
                  </p>
                </div>

                <div className="pt-4 border-t">
                  <span className="font-semibold block mb-2">Bank Details:</span>
                  <p className="text-xs text-muted-foreground italic">
                    Bank details would be displayed here (read-only for security)
                  </p>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
